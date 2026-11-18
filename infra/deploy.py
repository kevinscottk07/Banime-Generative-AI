#!/usr/bin/env python3
"""One-command deploy of Banime to your AWS account.

    pip install boto3
    python infra/deploy.py --admin-email you@example.com --budget-email you@example.com

Idempotent: re-run it after any code change. Teardown: --destroy.
Requires credentials for the target account (AWS_PROFILE or env vars).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time
import zipfile

import boto3
from botocore.exceptions import ClientError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGION = "us-west-2"  # Luma Ray2 + Stable Image Core live here


def build_zip() -> bytes:
    buf = io.BytesIO()
    src = os.path.join(ROOT, "backend", "banime")
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        files = [(f"banime/{n}", os.path.join(src, n)) for n in sorted(os.listdir(src)) if n.endswith(".py")]
        site = os.path.join(ROOT, "frontend")  # bundled so the worker can publish the site (publish.py)
        files += [(f"banime/site/{n}", os.path.join(site, n)) for n in ("index.html", "styles.css", "app.js", "demo.js")]
        for arc, path in files:
            info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            z.writestr(info, open(path, "rb").read(), zipfile.ZIP_DEFLATED, compresslevel=9)
    return buf.getvalue()


def stack_outputs(cfn, name):
    s = cfn.describe_stacks(StackName=name)["Stacks"][0]
    return s["StackStatus"], {o["OutputKey"]: o["OutputValue"] for o in s.get("Outputs", [])}


def wait(cfn, name):
    while True:
        status, out = stack_outputs(cfn, name)
        if not status.endswith("_IN_PROGRESS"):
            return status, out
        print(f"  {status} ...")
        time.sleep(15)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stack", default="banime")
    ap.add_argument("--admin-email", default="")
    ap.add_argument("--budget-email", default="")
    ap.add_argument("--animate-policy", default="admins", choices=["admins", "all"])
    ap.add_argument("--monthly-video-cap", default="40")
    ap.add_argument("--google-client-id", default="")
    ap.add_argument("--google-client-secret", default="")
    ap.add_argument("--destroy", action="store_true")
    a = ap.parse_args()

    sess = boto3.Session(region_name=REGION)
    cfn, s3 = sess.client("cloudformation"), sess.client("s3")
    account = sess.client("sts").get_caller_identity()["Account"]
    artifacts = f"kyverin-studio-artifacts-{account}-{REGION}"

    if a.destroy:
        _, out = stack_outputs(cfn, a.stack)
        for b in (out.get("SiteBucket"), out.get("MediaBucket")):
            if b:
                bucket = sess.resource("s3").Bucket(b)
                bucket.objects.all().delete()
        cfn.delete_stack(StackName=a.stack)
        print("Deleting stack (takes a few minutes for CloudFront)…")
        cfn.get_waiter("stack_delete_complete").wait(StackName=a.stack, WaiterConfig={"Delay": 20, "MaxAttempts": 90})
        print("Deleted. The artifacts bucket", artifacts, "was kept; delete it manually if you like.")
        return

    # 1. artifacts bucket + lambda zip
    try:
        s3.head_bucket(Bucket=artifacts)
    except ClientError:
        s3.create_bucket(Bucket=artifacts, CreateBucketConfiguration={"LocationConstraint": REGION})
        s3.put_public_access_block(Bucket=artifacts, PublicAccessBlockConfiguration={
            "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True})
    code = build_zip()
    key = f"bn/lambda/banime-{hashlib.sha256(code).hexdigest()[:16]}.zip"
    s3.put_object(Bucket=artifacts, Key=key, Body=code)
    print(f"Uploaded {key} ({len(code)} bytes)")

    # 2. stack
    params = {"CodeBucket": artifacts, "CodeKey": key, "AdminEmails": a.admin_email, "AnimatePolicy": a.animate_policy,
              "BudgetAlertEmail": a.budget_email, "MonthlyVideoCapUsd": a.monthly_video_cap,
              "GoogleClientId": a.google_client_id, "GoogleClientSecret": a.google_client_secret}
    kwargs = dict(StackName=a.stack, TemplateBody=open(os.path.join(ROOT, "infra", "template.yaml")).read(),
                  Parameters=[{"ParameterKey": k, "ParameterValue": v} for k, v in params.items()],
                  Capabilities=["CAPABILITY_IAM"], Tags=[{"Key": "app", "Value": "banime"}])
    try:
        cfn.describe_stacks(StackName=a.stack)
        try:
            cfn.update_stack(**kwargs)
        except ClientError as e:
            if "No updates" not in str(e):
                raise
    except ClientError as e:
        if "does not exist" not in str(e):
            raise
        cfn.create_stack(OnFailure="DELETE", **kwargs)
    status, out = wait(cfn, a.stack)
    if status not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        sys.exit(f"Stack ended in {status}. See the CloudFormation console events.")

    # 3. frontend: the Lambda package carries the site; it writes config.js from these outputs.
    cfg = {"apiUrl": out["ApiUrl"], "userPoolClientId": out["UserPoolClientId"], "authDomain": out["AuthDomain"],
           "google": out.get("GoogleEnabled") == "true"}
    sess.client("lambda").invoke(FunctionName=f"{a.stack}-api", Payload=json.dumps({"action": "publish_site", "payload": cfg}))
    sess.client("cloudfront").create_invalidation(DistributionId=cfn.describe_stack_resource(
        StackName=a.stack, LogicalResourceId="SiteDistribution")["StackResourceDetail"]["PhysicalResourceId"],
        InvalidationBatch={"Paths": {"Quantity": 1, "Items": ["/*"]}, "CallerReference": str(time.time())})
    print("\nBanime is live:", out["SiteUrl"])
    print("API:", out["ApiUrl"])


if __name__ == "__main__":
    main()
