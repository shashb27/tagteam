# IT & Network Notes — TPU Vendor Onboarding

Fictional demo data. IT-side checklist for the TPU pilot procurement.

## Firewall / network

- Vendor management portals (all three vendors) require OUTBOUND HTTPS (443)
  to each vendor's allowlisted domains:
  - CloudPeak: portal.cloudpeak.example (443)
  - Hyperion: console.hyperioncloud.example (443)
  - Arcline: vendors.arcline.example (443)
- Current status: an outbound-443 exception EXISTS for CloudPeak (added last
  quarter for the storage eval). Hyperion and Arcline are NOT yet on the
  allowlist — a firewall change request takes ~3 business days.
- No inbound ports are required by any vendor. Benchmark telemetry export
  uses outbound 443 as well.

## Quotas & accounts

- Cloud accelerator quota: current org quota is 32 chips; the pilot needs up
  to 64 (CloudPeak config). File the quota increase BEFORE the purchase
  order — approvals take 5–7 business days and are rejected retroactively.
- Service accounts for benchmark automation must go through the standard
  access-request flow (1–2 days).

## Timeline impact

If procurement picks Hyperion or Arcline, add ~3 days for the firewall
change on top of contract signature. CloudPeak is network-ready today but
requires the quota increase (5–7 days) before the 64-chip config can start.
