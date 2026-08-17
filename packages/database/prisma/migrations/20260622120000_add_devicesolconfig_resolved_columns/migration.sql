-- DeviceSolConfig: persist the bridge's empirical SOL-probe answer alongside
-- the existing heuristic recommendation columns. The discovery serial_ports
-- collector now carries a `resolved` block (port/baud/source/confirmed) plus a
-- per-tty `ports` map; these columns let consumers prefer the probed port/baud
-- over the recommendation. All nullable (existing rows get NULL); availablePorts
-- is a scalar list defaulting to empty.
ALTER TABLE "DeviceSolConfig"
  ADD COLUMN "resolvedPort" TEXT,
  ADD COLUMN "resolvedBaud" INTEGER,
  ADD COLUMN "resolvedSource" TEXT,
  ADD COLUMN "resolvedConfirmed" BOOLEAN,
  ADD COLUMN "availablePorts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
