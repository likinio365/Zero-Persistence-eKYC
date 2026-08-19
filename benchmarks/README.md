# Benchmarks

## k6 — Write Saturation Test

Μετράει το write throughput του συστήματος υπό αυξανόμενο φόρτο.
Κάθε iteration εκτελεί **POST /api/kyc** — πλήρης write pipeline:
Vault Transit encrypt → IPFS upload → Fabric invoke (consensus).

### Install k6
```bash
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

### Run
```bash
cd benchmarks/k6/scenarios
k6 run -e BASE_URL=https://e-kyc.cloud-ip.cc \
       -e USER_PASS=<password> \
       --out json=/home/liks/kyc2-system/benchmarks/results/write-saturation.json \
       05-write-saturation.js
```

### Stages (ramp-up)
| Στάδιο | Διάρκεια | VUs |
|--------|----------|-----|
| Baseline | 30s | 0 → 30 |
| Light | 60s | 30 → 50 |
| Moderate | 60s | 50 → 100 |
| Heavy | 60s | 100 → 150 |
| Saturation | 60s | 150 → 200 |
| Cool-down | 30s | 200 → 0 |

### Αποτελέσματα (2026-07-02)
| VUs | Throughput | avg latency | p(95) | Errors |
|-----|-----------|-------------|-------|--------|
| 30 | 6.1 TPS | 1.77s | ~3s | 0% |
| 200 | 11.4 TPS | 8s | 16.4s | 0% |

**Saturation point:** ~200 VUs — το throughput πλαφονάρει στα ~11 TPS.
Bottleneck: IPFS upload + Vault encryption overhead ανά transaction (όχι το Fabric).

---

## Caliper — Pure Fabric TPS

Μετράει chaincode TPS χωρίς HTTP/IPFS/Vault overhead — απομονώνει την απόδοση του Fabric ledger.

### Install
```bash
cd benchmarks/caliper
npm install --save-dev @hyperledger/caliper-cli@0.6.0
npx caliper bind --caliper-bind-sut fabric:2.4
```

### Run — Standard benchmark (1, 5, 10, 20, 50 TPS)
```bash
npx caliper launch manager \
  --caliper-workspace . \
  --caliper-networkconfig network.yaml \
  --caliper-benchconfig benchmark.yaml \
  --caliper-flow-only-test \
  --caliper-report-path ../results/caliper-report.html
```

### Run — Saturation benchmark (50, 100, 150, 200, 300 TPS)
```bash
npx caliper launch manager \
  --caliper-workspace . \
  --caliper-networkconfig network.yaml \
  --caliper-benchconfig benchmark-saturation.yaml \
  --caliper-flow-only-test \
  --caliper-report-path ../results/caliper-saturation.html
```

### Αποτελέσματα standard (2026-07-02)
| Send Rate | Throughput | Avg Latency | Fail |
|-----------|-----------|-------------|------|
| 1 TPS | 1.0 TPS | 1.22s | 0 |
| 5 TPS | 4.8 TPS | 1.04s | 0 |
| 10 TPS | 9.7 TPS | 0.58s | 0 |
| 20 TPS | 19.3 TPS | 0.36s | 0 |
| 50 TPS | 48.3 TPS | 0.59s | 0 |

Pure Fabric throughput efficiency: **96.6%** στους 50 TPS, 0 failures.
