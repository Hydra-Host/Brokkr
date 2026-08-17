#!/usr/bin/env bash
# Runs INSIDE an amd64 ubuntu container (invoked by grub_build.py). Mirrors
# bridge-api's Dockerfile grub-build stage: install GRUB multiarch and emit the
# standalone EFI + legacy bootloaders, each embedding the matching /cfg/grub-*.cfg
# as grub.cfg. Mounts: /cfg = bridge boot/grub (ro), /export = output dir.
set -eux

sed -i '/^Components:/a Architectures: amd64' /etc/apt/sources.list.d/ubuntu.sources
dpkg --add-architecture arm64
cat >/etc/apt/sources.list.d/ubuntu-ports.sources <<'EOF'
Types: deb
URIs: http://ports.ubuntu.com/ubuntu-ports/
Suites: noble noble-updates noble-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Architectures: arm64
EOF

apt-get update -qq
apt-get install -y --no-install-recommends \
  grub-common grub-efi-amd64-bin grub-efi-arm64-bin:arm64 grub-pc-bin >/dev/null

# Note: efidisk.mod isn't shipped by Debian/Ubuntu's grub-efi-{amd64,arm64}-bin
# (its functionality is rolled into the generic disk.mod). Don't add it to
# --modules -- grub-mkstandalone aborts when a listed module file is missing.
efi_mods="part_gpt fat ext2 xfs lvm mdraid09 mdraid1x chain search search_fs_file configfile normal echo test sleep"
grub-mkstandalone --format=x86_64-efi --modules="$efi_mods" --output=/export/bootx64.efi \
  'boot/grub/grub.cfg=/cfg/grub-efi-amd64.cfg'
grub-mkstandalone --format=arm64-efi --modules="$efi_mods" --output=/export/bootaa64.efi \
  'boot/grub/grub.cfg=/cfg/grub-efi-arm64.cfg'

mods="boot cat chain configfile echo ext2 fat gzio halt iso9660 linux linux16 normal part_gpt part_msdos reboot search search_fs_file search_fs_uuid search_label test tftp"
grub-mkstandalone --format=i386-pc --output=/export/core.img \
  --install-modules="$mods" --modules="$mods" \
  --locales="" --fonts="" --directory=/usr/lib/grub/i386-pc \
  'boot/grub/grub.cfg=/cfg/grub-legacy.cfg'

test -s /export/bootx64.efi && test -s /export/bootaa64.efi && test -s /export/core.img
