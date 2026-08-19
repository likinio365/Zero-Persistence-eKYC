# Benchmarks

Performance benchmarks for the KYC system. Two tools are used: **Hyperledger Caliper** for Fabric chaincode throughput, and **k6** for HTTP API load testing.

## Caliper (Fabric chaincode)

Measures raw chaincode throughput (TPS), latency, and success rate against a running Fabric network.

```
benchmarks/caliper/
├── benchmarks/
│   └── kyc-benchmark.yaml     # workload definition (rounds, rates, workers)
├── workload/
│   ├── submitKYC.js           # submit workload module
│   ├── getKYC.js              # read workload module
│   └── resubmitKYC.js         # resubmit workload module
└── connection-profile.yaml    # Fabric network connection profile
```

### Prerequisites

1. Running Fabric network with chaincode deployed
2. Node.js 18+
3. Caliper CLI

```bash
cd benchmarks/caliper
npm install
```

### Run

```bash
cd benchmarks/caliper
npx caliper launch manager \
  --caliper-workspace . \
  --caliper-benchconfig benchmarks/kyc-benchmark.yaml \
  --caliper-networkconfig connection-profile.yaml
```

Results are written to `benchmarks/results/` (gitignored).

## k6 (HTTP API)

Load-tests the backend API endpoints under configurable concurrency.

```
benchmarks/k6/
├── submit-kyc.js           # POST /api/kyc load test
├── verify-kyc.js           # PUT /api/kyc/:id/verify load test
├── full-flow.js            # end-to-end: submit → verify → status check
└── utils/
    └── auth.js             # shared login helper
```

### Prerequisites

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

### Run

```bash
# Target a local instance (default)
k6 run benchmarks/k6/submit-kyc.js

# Target a specific deployment
BASE_URL=https://your-domain.example.com k6 run benchmarks/k6/submit-kyc.js

# With custom VUs and duration
k6 run --vus 10 --duration 30s benchmarks/k6/submit-kyc.js
```

All scripts read `BASE_URL` from the environment (default: `http://localhost:3000`). The `USER_USERNAME` and `USER_PASSWORD` env vars are used for authentication if set; otherwise the scripts use their own defaults — override for production deployments.

## Representative Results

> Measured on a single-node VPS (2 vCPU, 4 GB RAM) running the full Docker Compose stack.

### Caliper — SubmitKYC (30 s, 5 workers)

| Metric | Value |
|--------|-------|
| TPS (avg) | ~12 tx/s |
| Latency (avg) | 420 ms |
| Latency (p99) | 810 ms |
| Success rate | 100% |

### Caliper — GetKYC (read-only, 30 s, 5 workers)

| Metric | Value |
|--------|-------|
| TPS (avg) | ~48 tx/s |
| Latency (avg) | 105 ms |
| Latency (p99) | 230 ms |
| Success rate | 100% |

### k6 — POST /api/kyc (10 VUs, 30 s)

| Metric | Value |
|--------|-------|
| Requests/s | ~8 req/s |
| p95 response | 890 ms |
| Error rate | 0% |

The bottleneck is Vault Transit encryption + IPFS upload (network round-trips), not Fabric ordering.
