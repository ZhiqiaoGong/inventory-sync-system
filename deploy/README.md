# Deploying the v2 stack on AWS

The v2 stack (Node app + Go relay + Go consumer + Redpanda) runs on **one EC2
box under `docker compose`** — the same compose file used locally, no
orchestrator.

That is a deliberate choice, not a shortcut. ECS/EKS exist to schedule
containers across a fleet; this demo has four containers on one host and no
scaling or failover requirement, so an orchestrator would add a control plane,
a task definition, and a load balancer (~$16/mo on its own) to buy nothing the
compose file doesn't already do. The same reasoning as v1 choosing SQLite:
match the machinery to the problem, and be able to say what would change the
answer. What would: needing more than one host, zero-downtime deploys, or
independent scaling of the consumer — at which point the containers are already
built and the compose file is the ECS task definition in embryo.

## The box is disposable

There is **no Elastic IP and no snapshot** — the instance is cattle, not a pet.
`deploy/bootstrap.sh` takes a bare Amazon Linux 2023 arm64 host to a running
stack with no manual steps, so the recovery procedure for anything is
"terminate it and launch another one."

The practical consequence: **the public IP changes on every launch** (and on
every stop/start). Nothing hardcodes it — the script reads it back from the
instance metadata and prints the URL. Read the IP off the EC2 console, or off
the bootstrap output in the system log.

## Launching

EC2 → Launch instance:

| Setting        | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Region         | `us-west-2` (Oregon)                                          |
| AMI            | Amazon Linux 2023, **Architecture: 64-bit (Arm)**             |
| Instance type  | `t4g.small` — 2 GB RAM; `micro`'s 1 GB is too tight           |
| Key pair       | `inventory-sync-key`                                          |
| Network        | default VPC, public subnet, auto-assign public IP **enabled** |
| Security group | inbound `22` from **My IP**, `3000` from anywhere             |
| Storage        | **12 GiB** gp3 — the 8 GiB default leaves no room for builds  |
| Advanced       | paste `deploy/bootstrap.sh` into **User data**                |

The AMI architecture is the easy one to get wrong: pick x86 by accident and
`t4g.small` vanishes from the instance type list with no explanation.

With the script in user data the instance provisions itself on first boot —
allow ~5 minutes for image builds on 2 vCPUs, then open `http://<public-ip>:3000`.

To run it by hand on a box that is already up:

```bash
scp -i ~/.ssh/inventory-sync-key.pem deploy/bootstrap.sh ec2-user@<ip>:/tmp/
ssh -i ~/.ssh/inventory-sync-key.pem ec2-user@<ip> 'sudo bash /tmp/bootstrap.sh'
```

## Verifying

```bash
curl http://<ip>:3000/health                    # {"ok":true}
curl -X POST http://<ip>:3000/sync/all          # tier1 SKUs -> "enqueued"
curl http://<ip>:3000/push-jobs                 # all "succeeded", attempts: 1
```

The write-backs go out over the real pipeline — the app only enqueues
(`DEFER_WRITEBACK=true`), the relay publishes to Kafka, the consumer delivers:

```bash
ssh -i ~/.ssh/inventory-sync-key.pem ec2-user@<ip>
cd inventory-sync-system
sudo docker compose logs relay      # relay published job #N SKU/platform
sudo docker compose logs consumer   # [writeback] job #N ... -> succeeded
```

## Tearing down

**Terminate** the instance when you're done — stopping it keeps billing the EBS
volume, and there is nothing on the box worth preserving. Terminate takes the
volume with it. The key pair and security group are free to leave in place;
they are reused by the next launch.

Afterwards, confirm nothing is left billing: EC2 → Instances (terminated),
Volumes (empty), Elastic IPs (empty).

## Costs

Pay-as-you-go — this account has no free tier left, so the box bills from the
moment it launches:

| Item        | Rate                 |
| ----------- | -------------------- |
| t4g.small   | ~$0.017/hour         |
| 12 GiB gp3  | ~$0.001/hour         |
| public IPv4 | ~$0.005/hour         |
| data out    | first 100 GB/mo free |

About **$0.023/hour, so ~$17/month if left running** — which is exactly why it
isn't. Run it for a demo, terminate it after. A $5 AWS Budget alarm is the
backstop.

Deliberately avoided: NAT Gateway (~$32/mo — a public subnet needs none), ALB
(~$16/mo — one host needs none), Elastic IP (bills when idle), ECR (the box
builds its own images).

## Notes on Amazon Linux 2023

Two things that cost time the first time:

- **There is no `docker-compose-plugin` package.** `dnf install docker` gets the
  engine and nothing else; both CLI plugins come from Docker's own GitHub
  releases. Guides that say otherwise are describing a different distro.
- **The bundled buildx is old** (0.12), and compose v5 refuses to build against
  anything below 0.17 — the failure reads `compose build requires buildx 0.17.0
or later` and stops the build dead. Both versions are pinned in the script for
  this reason; bumping one means checking the other.
