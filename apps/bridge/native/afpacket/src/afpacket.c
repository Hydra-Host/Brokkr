/**
 * Raw Ethernet frame send/receive N-API addon.
 *
 * Two platform backends behind one API:
 *   - Linux : AF_PACKET SOCK_RAW socket bound to an interface (classic BPF filter).
 *   - macOS : BSD /dev/bpf device bound to an interface (same classic BPF filter).
 * Both deliver full Ethernet frames from offset 0, so the JS-supplied BPF program
 * (ethernet-relative offsets) is identical across platforms.
 *
 * Exports create(ifname, bpfFilter) -> { ifindex, mac, onFrame, send, close }.
 *
 * Build: node-gyp rebuild. binding.gyp emits a "none" target on non-Linux/non-macOS
 * so the build is a no-op there and the JS loader falls back to dgram.
 */

#if defined(__linux__) || defined(__APPLE__)

#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <pthread.h>
#include <stdatomic.h>
#include <inttypes.h>

#if defined(__linux__)
#include <net/ethernet.h>
#include <netpacket/packet.h>
#include <linux/filter.h>
#elif defined(__APPLE__)
#include <fcntl.h>
#include <net/bpf.h>
#include <net/if_dl.h>
#include <ifaddrs.h>
#endif

#define MAX_FRAME_SIZE 65535
#define MAC_LEN 6

/* ------------------------------------------------------------------ */
/* Per-socket state                                                    */
/* ------------------------------------------------------------------ */

typedef struct {
  int fd;
  int ifindex;
  unsigned char mac[MAC_LEN];
  unsigned int read_buflen; /* BSD only: kernel-required BPF read buffer length */
  atomic_int running;      /* C11 atomic — ARM (Apple Silicon) needs acquire/release semantics */
  int thread_started;      /* explicit flag — pthread_t has no portable "not started" sentinel */
  int closed;         /* prevents double-close between handle_close and GC destructor */
  atomic_uint_fast64_t drop_count; /* frames dropped because the TSFN queue was full */
  pthread_t recv_thread;
  napi_threadsafe_function tsfn;
} afpacket_handle_t;

/* Data passed from the recv thread to the JS thread via the tsfn. */
typedef struct {
  int ifindex;
  unsigned char src_mac[MAC_LEN];
  unsigned char *frame;
  size_t frame_len;
} recv_data_t;

/* ------------------------------------------------------------------ */
/* Receive thread                                                      */
/* ------------------------------------------------------------------ */

/* Copy one frame onto the heap and hand it to JS. Non-blocking enqueue; if JS is
   overwhelmed the frame is dropped. Shared by both platform recv paths. */
static void enqueue_frame(afpacket_handle_t *h, int ifindex,
                          const unsigned char *src_mac,
                          const unsigned char *frame, size_t len) {
  recv_data_t *data = malloc(sizeof(recv_data_t));
  if (!data) return;
  data->ifindex = ifindex;
  memcpy(data->src_mac, src_mac, MAC_LEN);
  data->frame = malloc(len);
  if (!data->frame) { free(data); return; }
  memcpy(data->frame, frame, len);
  data->frame_len = len;
  if (napi_call_threadsafe_function(h->tsfn, data, napi_tsfn_nonblocking) != napi_ok) {
    free(data->frame);
    free(data);
    uint_fast64_t count = atomic_fetch_add_explicit(&h->drop_count, 1, memory_order_relaxed) + 1;
    /* Throttled warning: log on the first drop and then every 1000th. */
    if (count == 1 || count % 1000 == 0) {
      fprintf(stderr, "afpacket: TSFN queue full, %" PRIuFAST64 " frame(s) dropped so far\n", count);
    }
  }
}

static void *recv_loop(void *arg) {
  afpacket_handle_t *h = (afpacket_handle_t *)arg;

#if defined(__linux__)
  unsigned char buf[MAX_FRAME_SIZE];
  while (atomic_load_explicit(&h->running, memory_order_relaxed)) {
    struct sockaddr_ll sll;
    socklen_t sll_len = sizeof(sll);
    ssize_t n = recvfrom(h->fd, buf, sizeof(buf), 0,
                         (struct sockaddr *)&sll, &sll_len);
    if (n < 0) {
      /* SO_RCVTIMEO fires EAGAIN/EWOULDBLOCK periodically so the loop re-checks
         h->running and can exit on teardown — AF_PACKET recvfrom() is otherwise
         uninterruptible by close()/shutdown(). EINTR: retry likewise. */
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
      break; /* socket closed or fatal error */
    }
    if (n < 14) continue; /* too short for Ethernet */
    /* Drop frames from other interfaces: the socket starts receiving on ALL
       interfaces before bind() and SO_ATTACH_FILTER take effect. Even after
       bind, stale frames queued in the pre-bind window carry a foreign
       sll_ifindex. Checking here makes delivery correct regardless. */
    if (sll.sll_ifindex != h->ifindex) continue;
    enqueue_frame(h, sll.sll_ifindex, sll.sll_addr, buf, (size_t)n);
  }
#elif defined(__APPLE__)
  /* BPF reads return a batch of records, each prefixed by a struct bpf_hdr and
     padded to BPF_WORDALIGN. BIOCSRTIMEOUT bounds the blocking read so the loop
     re-checks h->running on teardown (mirrors the Linux SO_RCVTIMEO rationale).
     Heap-allocate to match BIOCGBLEN — a stack buf capped at MAX_FRAME_SIZE would
     silently drop BPF batch records that overflow the undersized user buffer. */
  size_t blen = (h->read_buflen > 0) ? h->read_buflen : MAX_FRAME_SIZE;
  unsigned char *bpf_buf = malloc(blen);
  if (!bpf_buf) return NULL;
  while (atomic_load_explicit(&h->running, memory_order_relaxed)) {
    ssize_t n = read(h->fd, bpf_buf, blen);
    if (n <= 0) {
      if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) continue;
      if (n == 0) continue; /* read timeout: no data this window */
      break;                /* fd closed or fatal error */
    }
    unsigned char *p = bpf_buf;
    unsigned char *end = bpf_buf + n;
    while (p + sizeof(struct bpf_hdr) <= end) {
      struct bpf_hdr *bh = (struct bpf_hdr *)p;
      unsigned char *frame = p + bh->bh_hdrlen;
      size_t caplen = bh->bh_caplen;
      size_t advance = BPF_WORDALIGN(bh->bh_hdrlen + bh->bh_caplen);
      if (advance == 0) break; /* malformed record — avoid an infinite loop */
      /* src MAC is bytes 6..11 of the Ethernet header (BPF gives no sockaddr). */
      if (caplen >= 14 && frame + caplen <= end) {
        enqueue_frame(h, h->ifindex, frame + MAC_LEN, frame, caplen);
      }
      p += advance;
    }
  }
  free(bpf_buf);
#endif
  return NULL;
}

/* Called on the JS thread for each received frame. */
static void recv_callback(napi_env env, napi_value js_cb, void *ctx, void *raw) {
  (void)ctx;
  recv_data_t *data = (recv_data_t *)raw;
  if (!data) return;

  /* On TSFN abort Node calls with env==NULL + non-NULL data; all napi_*
     calls would segfault. Free the payload and bail. */
  if (env == NULL) {
    free(data->frame);
    free(data);
    return;
  }

  napi_value global, ifindex_val, src_mac_val, frame_val;
  if (napi_get_global(env, &global) != napi_ok ||
      napi_create_int32(env, data->ifindex, &ifindex_val) != napi_ok) {
    free(data->frame);
    free(data);
    return;
  }

  void *mac_buf, *frame_buf;
  napi_status status;
  status = napi_create_buffer_copy(env, MAC_LEN, data->src_mac, &mac_buf, &src_mac_val);
  if (status != napi_ok) {
    free(data->frame);
    free(data);
    return;
  }
  status = napi_create_buffer_copy(env, data->frame_len, data->frame, &frame_buf, &frame_val);
  if (status != napi_ok) {
    free(data->frame);
    free(data);
    return;
  }

  napi_value argv[3] = { ifindex_val, src_mac_val, frame_val };
  napi_value result;
  napi_call_function(env, global, js_cb, 3, argv, &result);

  /* A JS throw in the frame handler must not propagate into the native TSFN
     dispatch loop — clear it so subsequent callbacks are not skipped. */
  bool is_pending = false;
  napi_is_exception_pending(env, &is_pending);
  if (is_pending) {
    napi_value ex;
    napi_get_and_clear_last_exception(env, &ex);
  }

  free(data->frame);
  free(data);
}

/* ------------------------------------------------------------------ */
/* JS-exposed methods on the handle                                    */
/* ------------------------------------------------------------------ */

/* handle.onFrame(callback) — register the JS receive handler and start recv thread */
static napi_value handle_on_frame(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], this_val;
  napi_get_cb_info(env, info, &argc, argv, &this_val, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "onFrame(callback) requires a callback argument");
    return NULL;
  }

  afpacket_handle_t *h;
  if (napi_unwrap(env, this_val, (void **)&h) != napi_ok) {
    napi_throw_error(env, NULL, "invalid handle object (wrong type or already GC'd)");
    return NULL;
  }

  /* Single-registration: a second onFrame() would overwrite h->tsfn (stranding
   * the prior tsfn's event-loop ref) and h->recv_thread (orphaning the first
   * thread — teardown can only join one). Reject instead of leaking. A call that
   * failed mid-setup leaves thread_started=0, so retry-after-failure is allowed. */
  if (h->thread_started) {
    napi_throw_error(env, NULL, "onFrame already registered on this handle");
    return NULL;
  }

  napi_value resource_name;
  napi_create_string_utf8(env, "afpacket_recv", NAPI_AUTO_LENGTH, &resource_name);

  napi_status tsfn_status = napi_create_threadsafe_function(
      env, argv[0], NULL, resource_name,
      256, 1, NULL, NULL, NULL,
      recv_callback, &h->tsfn);
  if (tsfn_status != napi_ok) {
    napi_throw_error(env, NULL, "failed to create threadsafe function for recv");
    return NULL;
  }

  atomic_store_explicit(&h->running, 1, memory_order_relaxed);
  int rc = pthread_create(&h->recv_thread, NULL, recv_loop, h);
  if (rc != 0) {
    atomic_store_explicit(&h->running, 0, memory_order_relaxed);
    napi_release_threadsafe_function(h->tsfn, napi_tsfn_abort);
    h->tsfn = NULL;
    napi_throw_error(env, NULL, "failed to create recv thread");
    return NULL;
  }
  h->thread_started = 1;

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/* handle.send(ifindex, dstMac, frame) — send a raw Ethernet frame.
   The frame already carries the full L2 header (dst MAC included); ifindex/dstMac
   are used only on Linux's sockaddr_ll. On macOS BIOCSHDRCMPLT is set so the kernel
   transmits our header verbatim. */
static napi_value handle_send(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3], this_val;
  napi_get_cb_info(env, info, &argc, argv, &this_val, NULL);
  if (argc < 3) {
    napi_throw_type_error(env, NULL, "send(ifindex, dstMac, frame) requires 3 arguments");
    return NULL;
  }

  afpacket_handle_t *h;
  if (napi_unwrap(env, this_val, (void **)&h) != napi_ok) {
    napi_throw_error(env, NULL, "invalid handle object (wrong type or already GC'd)");
    return NULL;
  }

  int32_t ifindex;
  if (napi_get_value_int32(env, argv[0], &ifindex) != napi_ok) {
    napi_throw_error(env, NULL, "send: failed to read ifindex argument");
    return NULL;
  }

  void *mac_data;
  size_t mac_len;
  if (napi_get_buffer_info(env, argv[1], &mac_data, &mac_len) != napi_ok) {
    napi_throw_error(env, NULL, "send: failed to read dstMac buffer");
    return NULL;
  }

  void *frame_data;
  size_t frame_len;
  if (napi_get_buffer_info(env, argv[2], &frame_data, &frame_len) != napi_ok) {
    napi_throw_error(env, NULL, "send: failed to read frame buffer");
    return NULL;
  }

  if (mac_len < MAC_LEN) {
    napi_throw_error(env, NULL, "dstMac must be at least 6 bytes");
    return NULL;
  }

#if defined(__linux__)
  struct sockaddr_ll sll;
  memset(&sll, 0, sizeof(sll));
  sll.sll_family = AF_PACKET;
  sll.sll_ifindex = ifindex;
  sll.sll_halen = MAC_LEN;
  if (mac_len >= MAC_LEN) {
    memcpy(sll.sll_addr, mac_data, MAC_LEN);
  }
  ssize_t sent = sendto(h->fd, frame_data, frame_len, 0,
                        (struct sockaddr *)&sll, sizeof(sll));
  if (sent < 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
#elif defined(__APPLE__)
  (void)ifindex;
  (void)mac_data;
  (void)mac_len;
  ssize_t sent = write(h->fd, frame_data, frame_len);
  if (sent < 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
#endif

  /* A short write means the kernel transmitted a truncated L2 frame — surface it as an error
     rather than letting the caller believe the whole DHCP frame went out. */
  if (sent >= 0 && (size_t)sent < frame_len) {
    napi_throw_error(env, NULL, "afpacket send: partial frame written");
    return NULL;
  }

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/*
 * Shared teardown: stops the recv thread, closes the fd, releases the tsfn.
 * Safe to call multiple times (guarded by h->closed).
 */
static void handle_teardown(afpacket_handle_t *h) {
  if (h->closed) return;
  h->closed = 1;

  /* relaxed is sufficient — pthread_join provides the acquire fence that orders
     all prior stores visible to the joined thread before it exits. */
  atomic_store_explicit(&h->running, 0, memory_order_relaxed);

  /* Signal the recv thread to wake immediately: on Linux, shutdown(SHUT_RDWR)
     unblocks a pending recvfrom; on both platforms, SO_RCVTIMEO / BIOCSRTIMEOUT
     ensures the thread wakes within 200ms and observes running==0. */
  if (h->fd >= 0) {
#if defined(__linux__)
    shutdown(h->fd, SHUT_RDWR);
#endif
  }

  /* Join the thread BEFORE closing the fd so the thread never reads/polls on a
     closed (or kernel-reused) file descriptor. The recv loop's bounded timeout
     ensures the join completes promptly. */
  if (h->thread_started) {
    pthread_join(h->recv_thread, NULL);
    h->thread_started = 0;
  }
  if (h->fd >= 0) {
    close(h->fd);
    h->fd = -1;
  }
  if (h->tsfn) {
    napi_release_threadsafe_function(h->tsfn, napi_tsfn_abort);
    h->tsfn = NULL;
  }
}

/* handle.close() — stop recv thread and close the socket */
static napi_value handle_close(napi_env env, napi_callback_info info) {
  napi_value this_val;
  napi_get_cb_info(env, info, NULL, NULL, &this_val, NULL);

  afpacket_handle_t *h;
  if (napi_unwrap(env, this_val, (void **)&h) != napi_ok) {
    napi_throw_error(env, NULL, "invalid handle object (wrong type or already GC'd)");
    return NULL;
  }

  handle_teardown(h);

  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/* GC destructor: runs teardown (if close() was already called, it's a no-op) then frees. */
static void handle_destructor(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  afpacket_handle_t *h = (afpacket_handle_t *)data;
  handle_teardown(h);
  free(h);
}

/* ------------------------------------------------------------------ */
/* Platform socket setup                                               */
/* ------------------------------------------------------------------ */

/*
 * Open + bind + filter the raw socket for `ifname`, resolving its ifindex and MAC.
 * On success returns fd >= 0 and fills the out-params; on failure throws a napi
 * error and returns -1. `out_buflen` is the BPF read buffer length (BSD) or 0 (Linux).
 */
static int plat_open(napi_env env, const char *ifname, napi_value bpf_array,
                     int *out_ifindex, unsigned char *out_mac, unsigned int *out_buflen) {
  uint32_t filter_len = 0;
  if (napi_get_array_length(env, bpf_array, &filter_len) != napi_ok) {
    napi_throw_type_error(env, NULL, "bpf filter must be an array");
    return -1;
  }
  *out_buflen = 0;
  memset(out_mac, 0, MAC_LEN);

#if defined(__linux__)
  int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
  if (fd < 0) { napi_throw_error(env, NULL, strerror(errno)); return -1; }

  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);
  if (ioctl(fd, SIOCGIFINDEX, &ifr) < 0) { close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1; }
  *out_ifindex = ifr.ifr_ifindex;

  memset(&ifr, 0, sizeof(ifr));
  strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);
  if (ioctl(fd, SIOCGIFHWADDR, &ifr) < 0) { close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1; }
  memcpy(out_mac, ifr.ifr_hwaddr.sa_data, MAC_LEN);

  /* Attach the BPF filter BEFORE bind so no unfiltered frames queue in the
     socket between bind and filter attachment (closes a race window where
     non-DHCP traffic could arrive and be delivered to JS). */
  struct sock_filter *bpf = calloc(filter_len ? filter_len : 1, sizeof(struct sock_filter));
  if (!bpf) { close(fd); napi_throw_error(env, NULL, "malloc failed for BPF filter"); return -1; }
  for (uint32_t i = 0; i < filter_len; i++) {
    napi_value row, v; int32_t val;
    napi_get_element(env, bpf_array, i, &row);
    napi_get_element(env, row, 0, &v); napi_get_value_int32(env, v, &val); bpf[i].code = (unsigned short)val;
    napi_get_element(env, row, 1, &v); napi_get_value_int32(env, v, &val); bpf[i].jt = (unsigned char)val;
    napi_get_element(env, row, 2, &v); napi_get_value_int32(env, v, &val); bpf[i].jf = (unsigned char)val;
    napi_get_element(env, row, 3, &v); napi_get_value_int32(env, v, &val); bpf[i].k = (unsigned int)val;
  }
  struct sock_fprog prog = { .len = (unsigned short)filter_len, .filter = bpf };
  if (setsockopt(fd, SOL_SOCKET, SO_ATTACH_FILTER, &prog, sizeof(prog)) < 0) {
    free(bpf); close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1;
  }
  free(bpf);

  /* Bind the interface AFTER the filter is attached. */
  struct sockaddr_ll sll;
  memset(&sll, 0, sizeof(sll));
  sll.sll_family = AF_PACKET;
  sll.sll_protocol = htons(ETH_P_ALL);
  sll.sll_ifindex = *out_ifindex;
  if (bind(fd, (struct sockaddr *)&sll, sizeof(sll)) < 0) { close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1; }

  /* Reject an all-zero resolved MAC (invalid L2 source — same check as macOS). */
  static const unsigned char zero_mac[MAC_LEN] = {0};
  if (memcmp(out_mac, zero_mac, MAC_LEN) == 0) {
    close(fd);
    napi_throw_error(env, NULL, "could not resolve MAC address for interface");
    return -1;
  }

  /* Bounded recv timeout so recv_loop wakes periodically and observes h->running == 0
     during teardown (AF_PACKET recvfrom() is not interrupted by close()/shutdown()). */
  struct timeval rcv_to = { .tv_sec = 0, .tv_usec = 200000 };
  if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &rcv_to, sizeof(rcv_to)) < 0) {
    close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1;
  }
  return fd;

#elif defined(__APPLE__)
  /* Scan /dev/bpf0..bpf255 for the first free one. EBUSY -> next; EACCES/ENOENT -> stop
     (EACCES is the unprivileged case → the JS loader falls back to dgram). */
  int fd = -1;
  for (int i = 0; i < 256; i++) {
    char dev[16];
    snprintf(dev, sizeof(dev), "/dev/bpf%d", i);
    fd = open(dev, O_RDWR);
    if (fd >= 0) break;
    if (errno == EBUSY) continue;
    break;
  }
  if (fd < 0) { napi_throw_error(env, NULL, strerror(errno)); return -1; }

  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  strncpy(ifr.ifr_name, ifname, IFNAMSIZ - 1);
  if (ioctl(fd, BIOCSETIF, &ifr) < 0) { close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1; }

  /* Must be Ethernet for our frame/filter offsets to hold. */
  u_int dlt = 0;
  if (ioctl(fd, BIOCGDLT, &dlt) < 0 || dlt != DLT_EN10MB) {
    close(fd); napi_throw_error(env, NULL, "interface is not Ethernet (DLT_EN10MB)"); return -1;
  }

  u_int enable = 1;
  if (ioctl(fd, BIOCIMMEDIATE, &enable) < 0)
    fprintf(stderr, "afpacket: BIOCIMMEDIATE: %s (non-fatal)\n", strerror(errno));
  /* Fatal: without HDRCMPLT the kernel rewrites our L2 dst MAC on every send,
     corrupting unicast DHCP replies. The JS loader falls back to dgram. */
  if (ioctl(fd, BIOCSHDRCMPLT, &enable) < 0) {
    fprintf(stderr, "afpacket: BIOCSHDRCMPLT: %s\n", strerror(errno));
    close(fd);
    napi_throw_error(env, NULL, "BIOCSHDRCMPLT failed — cannot send raw frames with caller-supplied L2 header");
    return -1;
  }
  u_int seesent = 0;
  if (ioctl(fd, BIOCSSEESENT, &seesent) < 0)
    fprintf(stderr, "afpacket: BIOCSSEESENT: %s (recv loop may see own TX)\n", strerror(errno));

  if (ioctl(fd, BIOCGBLEN, out_buflen) < 0) { close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1; }

  struct bpf_insn *insns = calloc(filter_len ? filter_len : 1, sizeof(struct bpf_insn));
  if (!insns) { close(fd); napi_throw_error(env, NULL, "malloc failed for BPF filter"); return -1; }
  for (uint32_t i = 0; i < filter_len; i++) {
    napi_value row, v; int32_t val;
    napi_get_element(env, bpf_array, i, &row);
    napi_get_element(env, row, 0, &v); napi_get_value_int32(env, v, &val); insns[i].code = (u_short)val;
    napi_get_element(env, row, 1, &v); napi_get_value_int32(env, v, &val); insns[i].jt = (u_char)val;
    napi_get_element(env, row, 2, &v); napi_get_value_int32(env, v, &val); insns[i].jf = (u_char)val;
    napi_get_element(env, row, 3, &v); napi_get_value_int32(env, v, &val); insns[i].k = (bpf_u_int32)val;
  }
  struct bpf_program prog = { .bf_len = filter_len, .bf_insns = insns };
  if (ioctl(fd, BIOCSETF, &prog) < 0) { free(insns); close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1; }
  free(insns);

  /* Flush the BPF buffer: BIOCSETIF may have queued frames before BIOCSETF
     attached the filter. BIOCFLUSH discards them so no unfiltered frames reach
     the recv loop. */
  if (ioctl(fd, BIOCFLUSH) < 0) {
    fprintf(stderr, "afpacket: BIOCFLUSH: %s (non-fatal)\n", strerror(errno));
  }

  /* Bounded read timeout so recv_loop re-checks h->running on teardown.
     Fatal: without it, read() blocks indefinitely and pthread_join hangs. */
  struct timeval rcv_to = { .tv_sec = 0, .tv_usec = 200000 };
  if (ioctl(fd, BIOCSRTIMEOUT, &rcv_to) < 0) {
    close(fd); napi_throw_error(env, NULL, strerror(errno)); return -1;
  }

  *out_ifindex = (int)if_nametoindex(ifname);
  if (*out_ifindex == 0) {
    close(fd);
    napi_throw_error(env, NULL, "if_nametoindex failed: interface not found");
    return -1;
  }

  /* Resolve the interface MAC via AF_LINK. Fail if unresolvable — a zero MAC
     would produce DHCP replies with an invalid source L2 address. Linux's
     SIOCGIFHWADDR path is already fatal on failure; match that parity. */
  struct ifaddrs *ifap = NULL;
  if (getifaddrs(&ifap) == 0) {
    for (struct ifaddrs *ifa = ifap; ifa; ifa = ifa->ifa_next) {
      if (ifa->ifa_addr && ifa->ifa_addr->sa_family == AF_LINK && strcmp(ifa->ifa_name, ifname) == 0) {
        struct sockaddr_dl *sdl = (struct sockaddr_dl *)ifa->ifa_addr;
        if (sdl->sdl_alen == MAC_LEN) memcpy(out_mac, LLADDR(sdl), MAC_LEN);
        break;
      }
    }
    freeifaddrs(ifap);
  }
  static const unsigned char zero_mac[MAC_LEN] = {0};
  if (memcmp(out_mac, zero_mac, MAC_LEN) == 0) {
    close(fd);
    napi_throw_error(env, NULL, "could not resolve MAC address for interface");
    return -1;
  }
  return fd;
#endif
}

/* ------------------------------------------------------------------ */
/* create(ifname, bpfFilter) — module-level factory                    */
/* ------------------------------------------------------------------ */

static napi_value create(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "create(ifname, bpfFilter) requires 2 arguments");
    return NULL;
  }

  char ifname[IFNAMSIZ];
  size_t ifname_len;
  if (napi_get_value_string_utf8(env, argv[0], ifname, sizeof(ifname), &ifname_len) != napi_ok) {
    napi_throw_type_error(env, NULL, "create: ifname must be a string");
    return NULL;
  }

  int ifindex = 0;
  unsigned char if_mac[MAC_LEN];
  unsigned int read_buflen = 0;
  int fd = plat_open(env, ifname, argv[1], &ifindex, if_mac, &read_buflen);
  if (fd < 0) return NULL; /* plat_open already threw */

  afpacket_handle_t *h = calloc(1, sizeof(afpacket_handle_t));
  if (!h) {
    close(fd);
    napi_throw_error(env, NULL, "malloc failed for afpacket handle");
    return NULL;
  }
  h->fd = fd;
  h->ifindex = ifindex;
  h->read_buflen = read_buflen;
  memcpy(h->mac, if_mac, MAC_LEN);

  napi_value handle_obj;
  napi_create_object(env, &handle_obj);
  napi_wrap(env, handle_obj, h, handle_destructor, NULL, NULL);

  napi_value ifindex_val, mac_val;
  napi_create_int32(env, ifindex, &ifindex_val);
  void *mac_data;
  napi_create_buffer_copy(env, MAC_LEN, h->mac, &mac_data, &mac_val);
  napi_set_named_property(env, handle_obj, "ifindex", ifindex_val);
  napi_set_named_property(env, handle_obj, "mac", mac_val);

  napi_value on_frame_fn, send_fn, close_fn;
  napi_create_function(env, "onFrame", NAPI_AUTO_LENGTH, handle_on_frame, NULL, &on_frame_fn);
  napi_create_function(env, "send", NAPI_AUTO_LENGTH, handle_send, NULL, &send_fn);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, handle_close, NULL, &close_fn);
  napi_set_named_property(env, handle_obj, "onFrame", on_frame_fn);
  napi_set_named_property(env, handle_obj, "send", send_fn);
  napi_set_named_property(env, handle_obj, "close", close_fn);

  return handle_obj;
}

/* ------------------------------------------------------------------ */
/* Module init                                                         */
/* ------------------------------------------------------------------ */

static napi_value init(napi_env env, napi_value exports) {
  napi_value create_fn;
  napi_create_function(env, "create", NAPI_AUTO_LENGTH, create, NULL, &create_fn);
  napi_set_named_property(env, exports, "create", create_fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

#endif /* __linux__ || __APPLE__ */
