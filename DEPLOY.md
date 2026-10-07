# Deploying Snapcode to Oracle Cloud Free Tier

This guide takes you from "nothing" to "Snapcode running publicly with HTTPS"
on Oracle Cloud's Always-Free VPS tier. It's genuinely free forever (not a
trial) and gives you a real server with full root access — unlike Render,
Railway, or Fly.io free plans, which block the Docker-in-Docker access
Snapcode needs to spin up containers.

---

## 1. Create the Oracle Cloud account and VPS

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (requires a card
   for identity verification — you will not be charged on the Free Tier).
2. In the console, go to **Compute → Instances → Create Instance**.
3. Choose the **Ampere A1 (ARM)** shape — the Always-Free tier gives you up
   to 4 OCPUs and 24GB RAM total, which is generous for this project.
   (If ARM capacity is unavailable in your region, the **VM.Standard.E2.1.Micro**
   x86 shape is also always-free, just smaller — 1 OCPU / 1GB RAM. Works for
   testing, tight for real concurrent use.)
4. Choose **Ubuntu 22.04** as the image.
5. Under networking, let it create a new VCN — this also opens port 22 (SSH)
   by default.
6. Download the SSH key pair it generates (or upload your own public key).
7. Create the instance and note its **public IP address**.

## 2. Open the ports you need

By default only port 22 is open. You need 80 and 443 (HTTP/HTTPS) reachable
too, in **two places**:

**A. Oracle's Security List** (console-side firewall):
Networking → Virtual Cloud Networks → your VCN → Security Lists → default
security list → Add Ingress Rules:
- Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port `80`
- Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port `443`

**B. The instance's own firewall (iptables/ufw)** — Oracle's Ubuntu images
ship with iptables rules that block everything but 22 even after you open
the Security List. Once SSH'd in (step 3), run:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save   # if installed; otherwise:
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

## 3. SSH in and install Docker

```bash
ssh -i /path/to/your-key.pem ubuntu@<your-instance-ip>
```

Then install Docker:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# let your user run docker without sudo
sudo usermod -aG docker $USER
newgrp docker
```

Install Node.js 18+:

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

## 4. Clone and build Snapcode

```bash
git clone https://github.com/muhumuza684/snapcode.git
cd snapcode

docker build -t sandbox-python -f docker/python.Dockerfile docker/
docker build -t sandbox-node   -f docker/node.Dockerfile   docker/
docker build -t sandbox-dart   -f docker/dart.Dockerfile   docker/
docker build -t sandbox-go     -f docker/go.Dockerfile     docker/
docker build -t sandbox-c      -f docker/c.Dockerfile      docker/

cd server
npm install
```

## 5. Configure it for public exposure

Before running publicly, set at minimum a token so random internet traffic
can't execute code on your server for free, plus your concurrency/rate
limits sized for your instance:

```bash
export SANDBOX_TOKEN="pick-a-long-random-string-here"
export MAX_CONCURRENT_RUNS=6        # tune to your CPU/RAM (start conservative on the 1 OCPU free tier)
export RATE_LIMIT_MAX=20
export BAN_THRESHOLD=3
export BAN_DURATION_MINUTES=15
```

Put these in a `.env` file or your systemd service (step 7) so they persist
across reboots — exporting in a shell only lasts that session.

## 6. Run it

Quick test first:

```bash
npm start
```

Visit `http://<your-instance-ip>:4000` from your own browser to confirm it
works before wiring up the domain/HTTPS.

## 7. Keep it running (systemd)

Don't rely on a terminal session staying open. Create a service:

```bash
sudo tee /etc/systemd/system/snapcode.service > /dev/null <<'EOF'
[Unit]
Description=Snapcode sandbox server
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/snapcode/server
EnvironmentFile=/home/ubuntu/snapcode/server/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# put your env vars from step 5 into this file, KEY=VALUE per line, no quotes/export
nano /home/ubuntu/snapcode/server/.env

sudo systemctl daemon-reload
sudo systemctl enable snapcode
sudo systemctl start snapcode
sudo systemctl status snapcode
```

## 8. Put HTTPS in front of it (Caddy — recommended)

Skip Snapcode's built-in self-signed HTTPS for a public deployment — it
always shows a browser warning. Caddy gets you real, trusted HTTPS
automatically, for free, if you have a domain pointed at your server's IP.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Point your domain's A record at the instance's public IP, then:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
yourdomain.com {
    reverse_proxy localhost:4000
}
EOF

sudo systemctl reload caddy
```

Caddy automatically gets and renews a Let's Encrypt certificate — no manual
cert management. Visit `https://yourdomain.com`.

**No domain yet?** Skip this step for now and just use
`http://<instance-ip>:4000` while you're testing — add HTTPS once you have
a domain.

## 9. Sanity checks before sharing the link

```bash
node tests/verify-sandbox.js
node tests/security-check.js
node tests/concurrency-test.js
curl -s http://localhost:4000/stats | head
```

## Updating later

```bash
cd ~/snapcode
git pull
# rebuild only the images that changed, or all of them to be safe
docker build -t sandbox-python -f docker/python.Dockerfile docker/
# ...repeat for changed languages...
sudo systemctl restart snapcode
```

## Honest limits of this setup

- The free-tier instance has finite CPU/RAM — `MAX_CONCURRENT_RUNS` is your
  real safety valve against overload, not a formality. Watch `/stats` and
  `top`/`docker stats` under real traffic and tune it down if needed.
- Rate limiting and bans are in-memory/local-file — fine for one server,
  not for a future multi-server setup (would need Redis).
- This is still not a substitute for a real security audit if you ever plan
  to let strangers you don't trust run arbitrary code at scale.
