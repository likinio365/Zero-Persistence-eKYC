# IAC — Infrastructure as Code

Ansible playbooks for provisioning and configuring the VPS that hosts the KYC system.

## Files

```
iac/
├── site.yml                       # main playbook — installs Docker, Nginx, Certbot; copies stack
├── nginx_ssl.yml                  # configures Nginx virtual hosts + obtains SSL certificates
├── hosts.ini                      # [gitignored] inventory — your VPS IP(s)
└── users_vars_DO_NOT_SHARE.yml    # [gitignored] sensitive vars (domain, email, passwords)
```

`hosts.ini` and `users_vars_DO_NOT_SHARE.yml` are excluded from git (see `.gitignore`). Copy the examples below and fill in your values before running.

## Prerequisites

```bash
pip install ansible
ansible --version   # >= 2.14 recommended
```

SSH key-based access to the VPS (password auth not supported by these playbooks).

## Setup

1. Create `iac/hosts.ini`:

```ini
[kyc_servers]
your-vps-ip ansible_user=your-ssh-user
```

2. Create `iac/users_vars_DO_NOT_SHARE.yml`:

```yaml
domain: "your-domain.example.com"
email: "your-email@example.com"
```

3. Run:

```bash
ansible-playbook -i iac/hosts.ini iac/site.yml
ansible-playbook -i iac/hosts.ini iac/nginx_ssl.yml
```

## What `site.yml` does

- Installs Docker CE + Docker Compose plugin
- Installs Nginx
- Copies the project directory to the VPS
- Ensures `ufw` allows necessary ports (22, 80, 443, 8030, 8040, and the bank frontend port)

## What `nginx_ssl.yml` does

- Writes Nginx server blocks for:
  - KYC app (`/`) → proxy to backend `:3000` and frontend `:3001`
  - Tails files (`/tails/`) → proxy to tails-server `:6543`
  - Bank frontend → separate server block on port 4000
- Runs `certbot --nginx` to obtain and auto-renew Let's Encrypt certificates

## Nginx Reverse Proxy Notes

| Location | Backend | Notes |
|----------|---------|-------|
| `/api/` | `http://localhost:3000` | Strips prefix, adds `X-Forwarded-*` headers |
| `/tails/` | `http://localhost:6543` | `proxy_http_version 1.1` required (tails-server uses chunked encoding) |
| `/` | `http://localhost:3001` | Serves React frontend |
| `:4000` (separate server) | `http://localhost:3002` | Bank portal, separate SSL cert block |

## Post-Deployment Checklist

After running the playbooks and starting the stack:

- [ ] Run `bash acapy/scripts/provision.sh` to register DID + cred def
- [ ] Rebuild frontend with `REACT_APP_CRED_DEF_ID` and `REACT_APP_API_URL`
- [ ] Re-upload tails file (if `docker compose down -v` was run)
- [ ] Publish revocation accumulator to BCovrin
- [ ] Open required firewall ports (22, 80, 443, 8030, 8040, and bank port)
