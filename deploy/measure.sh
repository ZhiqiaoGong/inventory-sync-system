#!/usr/bin/env bash
#
# Measures the end-to-end bootstrap time quoted in deploy/README.md, so the
# figure is reproducible instead of taken on trust.
#
# The clock starts at `run-instances` and stops when `/health` returns ok from
# outside the box — the same two endpoints the README quotes, with no SSH and
# no manual step in between.
#
#   SG_ID=sg-0123456789abcdef0 bash deploy/measure.sh          # one run
#   SG_ID=sg-... RUNS=5 bash deploy/measure.sh                 # five runs + spread
#   SG_ID=sg-... KEEP=1 bash deploy/measure.sh                 # leave the box up
#
# THIS SPENDS MONEY. Each run launches a real t4g.small and terminates it when
# the measurement lands (~$0.023/hour, so a handful of runs is under a cent).
# With KEEP=1 the instance is left running and billing — terminate it yourself.
set -euo pipefail

SG_ID=${SG_ID:-}
RUNS=${RUNS:-1}
REGION=${AWS_REGION:-us-west-2}
INSTANCE_TYPE=${INSTANCE_TYPE:-t4g.small}
KEY_NAME=${KEY_NAME:-inventory-sync-key}
KEEP=${KEEP:-0}
TIMEOUT=${TIMEOUT:-600} # give up on a single run after this many seconds

here=$(cd "$(dirname "$0")" && pwd)

if [ -z "$SG_ID" ]; then
  echo "SG_ID is required (the security group with 3000 open). See deploy/README.md." >&2
  exit 2
fi
for cmd in aws curl; do
  command -v "$cmd" >/dev/null || {
    echo "$cmd not found" >&2
    exit 2
  }
done

aws() { command aws --region "$REGION" "$@"; }

ami=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query Parameter.Value --output text)

# One measurement: launch, wait for healthy, print seconds. Echoes the elapsed
# time on stdout; everything else goes to stderr so the caller can collect it.
measure_once() {
  local run_label=$1 t0 id ip elapsed
  t0=$(date +%s)

  id=$(aws ec2 run-instances \
    --image-id "$ami" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --associate-public-ip-address \
    --block-device-mappings \
    '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":12,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --user-data "file://$here/bootstrap.sh" \
    --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Name,Value=inventory-sync-measure}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "[$run_label] launched $id" >&2

  # Terminate on any exit path, including Ctrl-C, unless explicitly kept.
  if [ "$KEEP" != "1" ]; then
    # shellcheck disable=SC2064  # $id must expand now, not at trap time
    trap "aws ec2 terminate-instances --instance-ids $id >/dev/null 2>&1 || true" RETURN INT TERM
  fi

  # The public IP is assigned on the pending → running transition. Poll for it
  # directly rather than using `aws ec2 wait`, whose 15s interval would blur
  # the measurement.
  while :; do
    ip=$(aws ec2 describe-instances --instance-ids "$id" \
      --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null || true)
    [ -n "$ip" ] && [ "$ip" != "None" ] && break
    [ $(($(date +%s) - t0)) -gt "$TIMEOUT" ] && {
      echo "[$run_label] no public IP within ${TIMEOUT}s" >&2
      return 1
    }
    sleep 2
  done
  echo "[$run_label] ip $ip — waiting for /health" >&2

  while :; do
    if curl -fsS --max-time 3 "http://${ip}:3000/health" >/dev/null 2>&1; then
      elapsed=$(($(date +%s) - t0))
      echo "[$run_label] healthy after ${elapsed}s" >&2
      echo "$elapsed"
      return 0
    fi
    [ $(($(date +%s) - t0)) -gt "$TIMEOUT" ] && {
      echo "[$run_label] not healthy within ${TIMEOUT}s (instance $id)" >&2
      return 1
    }
    sleep 2
  done
}

times=()
for i in $(seq 1 "$RUNS"); do
  if t=$(measure_once "run $i/$RUNS"); then
    times+=("$t")
  else
    echo "run $i failed; continuing" >&2
  fi
done

[ ${#times[@]} -eq 0 ] && {
  echo "no successful runs" >&2
  exit 1
}

sorted=$(printf '%s\n' "${times[@]}" | sort -n)
min=$(echo "$sorted" | head -1)
max=$(echo "$sorted" | tail -1)
median=$(echo "$sorted" | awk '{a[NR]=$1} END {print (NR%2) ? a[(NR+1)/2] : int((a[NR/2]+a[NR/2+1])/2)}')

echo
echo "run-instances → /health ok   (${#times[@]} run(s), $INSTANCE_TYPE, $REGION)"
echo "  samples : $(printf '%s ' "${times[@]}")"
echo "  min $min s · median $median s · max $max s"
[ "$KEEP" = "1" ] && echo "  KEEP=1 — instances left running; terminate them yourself."
