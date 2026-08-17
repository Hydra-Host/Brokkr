# BGP Domain

## What is BGP?

BGP (Border Gateway Protocol) is the routing protocol that makes the internet work. Every network on the internet is identified by an Autonomous System Number (ASN). BGP is how these networks tell each other which IP addresses they can reach -- they exchange "route advertisements" so traffic knows where to go.

In a data center context, BGP is used to announce customer IP prefixes to upstream providers and peers, and to control how traffic flows in and out of each zone.

## Entities

### ASN (Autonomous System Number)

A unique number (e.g., 65001) that identifies a network on the internet. Think of it like a phone number for a network -- it tells other networks who you are. Organizations own ASNs. Private ASNs (64512-65534) are used for internal routing that never touches the public internet. In Brokkr, each ASN belongs to an organization and represents that organization's network identity.

### Peer Group

A template for BGP session configuration. Rather than configuring every session from scratch, sessions that share the same policies (e.g., all upstream provider sessions) are grouped together. Think of it as a "session profile" -- change the group once, and all sessions in that group inherit the change. Peer groups belong to an organization.

### Prefix List

An ordered list of rules that filter which IP routes are accepted or advertised during a BGP session. Works like an access control list for routing -- "allow these subnets, deny everything else." A prefix list can optionally specify an address family (IPv4 or IPv6). Prefix lists belong to an organization.

### Prefix List Rule

A single entry in a prefix list. Each rule has:

- An **action** (permit or deny)
- An optional **prefix** (a CIDR block like 10.0.0.0/8)
- Optional **ge/le** bounds that expand the match to a range of prefix lengths
- A **sequence number** that determines when this rule is evaluated relative to others

Rules are evaluated in sequence order, lowest first. The first matching rule wins.

### BGP Session

An active peering relationship between two networks. A session runs on a specific device and connects a local ASN (ours) to a remote ASN (theirs) using local and remote IP addresses. Sessions can optionally reference a peer group for shared configuration and separate inbound/outbound prefix lists for route filtering.

## How They Relate

A **BGP Session** is the central entity. It connects a **local ASN** to a **remote ASN** via IP addresses on a device. The session can reference a **Peer Group** to inherit shared configuration. It can also reference two **Prefix Lists** -- one for inbound routes (what we accept from the peer) and one for outbound routes (what we advertise to the peer). Each Prefix List contains ordered **Prefix List Rules** that define the actual permit/deny logic.

```
Organization
  |-- ASN(s)
  |-- PeerGroup(s)
  |-- PrefixList(s)
  |     |-- PrefixListRule(s)  [ordered by sequence]
  |-- BgpSession(s)
        |-- localAsn  -> ASN
        |-- remoteAsn -> ASN
        |-- device    -> Device
        |-- peerGroup -> PeerGroup
        |-- prefixListIn  -> PrefixList  (accepted routes)
        |-- prefixListOut -> PrefixList  (advertised routes)
```

## Real-World Example

Zone A has ASN 65001. It peers with upstream provider Cloudflare (ASN 13335) via a BGP session on device `server-01`. The session uses an outbound prefix list that only advertises the customer /24 subnets, filtering out management prefixes. It also uses an inbound prefix list that accepts a default route from Cloudflare but denies specific bogon prefixes.

## Non-Obvious Business Rules

- **Rule evaluation order**: Prefix list rules are evaluated by sequence number, lowest first. The first matching rule determines the outcome. Rules are always returned sorted by sequence ascending.
- **ge/le prefix length ranges**: A rule with prefix 10.0.0.0/8, ge=24, le=32 matches any subnet from /24 to /32 within the 10.0.0.0/8 block. This lets a single rule cover a range of more-specific prefixes.
- **Session status lifecycle**: Sessions track their state -- ACTIVE (running), PLANNED (configured but not yet live), OFFLINE (down), DECOMMISSIONING (being removed). New sessions default to ACTIVE.
- **Separate inbound/outbound filtering**: A session has two independent prefix list references. The inbound list controls what routes are accepted from the peer. The outbound list controls what routes are advertised to the peer. Either or both can be omitted.
- **Brokkr-owned, no external sync**: These entities live solely in the Brokkr database, which is the source of truth. CRUD operations do not enqueue any sync job — the `netboxId` columns and the `device-netbox-sync` queue have been removed.
- **Cascading deletes**: Deleting a prefix list cascades to its rules. Deleting a BGP session does not cascade to its referenced prefix lists or peer group.
- **Parent validation**: Creating a prefix list rule validates that the parent prefix list exists before inserting.
