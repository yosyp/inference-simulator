# Infrastructure runbook

How the author stands up hosting for the Inference Simulator and what the deploy workflow does after that. The design is in `docs/06-deployment-ci-cd.md`. Agents prepare these commands; the author runs every command that touches AWS or GitHub secrets.

| Stack | Applied by | State | Manages |
|---|---|---|---|
| `infra/bootstrap/` | The author, locally: once, then again only to change the deploy role | Local at first, then `bootstrap/terraform.tfstate` in the state bucket (step 3) | GitHub OIDC provider, deploy role, state bucket |
| `infra/site/` | The deploy workflow, on every push to `prod` | `site/terraform.tfstate` in the state bucket | Site and log buckets, CloudFront, response headers, ACM certificate, DNS records, standard logging v2 |

The account ID, ARNs, bucket names, the site hostname, and GitHub's numeric IDs never enter the repo. They live in `infra/bootstrap/terraform.tfvars` (gitignored), GitHub secrets, and Terraform state.

## 1. Prerequisites

- Terraform 1.10 or later (1.10.5 is tested). Native S3 locking needs 1.10.
- AWS CLI v2, signed in to the account that holds the `yoschwab.com` hosted zone, with administrator rights. Bootstrap creates IAM resources. Check with `aws sts get-caller-identity`.
- `gh`, signed in with admin rights on `yosyp/inference-simulator`. Check with `gh auth status`.
- The site hostname, a subdomain of `yoschwab.com` (06 §9, item 2). It must not already have A, AAAA, or CNAME records.

Then check three things:

1. **Is there already a GitHub OIDC provider in the account?** An account can hold only one per URL.

   ```bash
   aws iam list-open-id-connect-providers
   ```

   If the list includes `token.actions.githubusercontent.com`, set `create_oidc_provider = false` in step 2. Its audiences must include `sts.amazonaws.com` (`aws iam get-open-id-connect-provider --open-id-connect-provider-arn <arn>`).

2. **Which OIDC subject does GitHub issue for this repo?**

   ```bash
   gh api repos/yosyp/inference-simulator/actions/oidc/customization/sub
   ```

   Repositories created after 2026-07-15 get immutable subjects: `repo:yosyp@<owner-id>/inference-simulator@<repo-id>:ref:refs/heads/prod` instead of `repo:yosyp/inference-simulator:ref:refs/heads/prod`. This repo was created on 2026-09-23 and reports `"use_immutable_subject": true`. Copy `sub_claim_prefix` into `github_oidc_subject_prefix` in step 2. With the default (the older form), GitHub's tokens won't match and every deploy fails at the AWS login step.

3. **Do CAA records allow Amazon to issue the certificate?**

   ```bash
   dig +short CAA yoschwab.com
   dig +short CAA <site hostname>
   ```

   No output is fine. If there are records, one must allow `amazon.com`, or ACM validation never completes.

## 2. Bootstrap apply (local state)

The committed `versions.tf` declares the S3 backend, but the bucket doesn't exist yet. A local override file, which `infra/.gitignore` ignores, swaps in a local backend for this first apply.

```bash
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars     # site_domain, github_oidc_subject_prefix, create_oidc_provider

cat > backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF

terraform init
terraform plan -out=bootstrap.tfplan
terraform apply bootstrap.tfplan
```

Check the plan before you apply: an OIDC provider (unless `create_oidc_provider = false`), the `inference-simulator-deploy` role and its inline policy, and a state bucket with versioning, encryption, public access block, ownership controls, and a policy. Nothing else.

Then confirm the trusted subject:

```bash
terraform output deploy_subject
```

It must be the `sub_claim_prefix` from step 1 followed by `:ref:refs/heads/prod`.

## 3. Migrate the bootstrap state into the bucket

```bash
STATE_BUCKET=$(terraform output -raw state_bucket_name)
rm backend_override.tf
terraform init -migrate-state -backend-config="bucket=$STATE_BUCKET"
# Answer "yes" when Terraform asks to copy the existing state to the new backend.

terraform plan                                  # expect "No changes."
aws s3 ls "s3://$STATE_BUCKET/bootstrap/"       # terraform.tfstate is there
rm -f terraform.tfstate terraform.tfstate.backup bootstrap.tfplan
```

The state now lives at `bootstrap/terraform.tfstate`. The deploy role can't read or write it: its policy covers only `site/terraform.tfstate` and that key's lock file, and the bucket policy explicitly denies it everything under `bootstrap/` (K20).

On another machine or a fresh clone, initialize with the same bucket. If you don't have the name, `aws s3 ls | grep inference-simulator-tfstate-` finds it.

```bash
terraform init -backend-config="bucket=<state bucket name>"
```

Re-apply bootstrap only to change the deploy role: a new site hostname, a missing permission, a new OIDC subject (after a repo rename or transfer), or the hardening under "Changing things later".

## 4. Set the GitHub secrets

From `infra/bootstrap`. Piping keeps the values out of your shell history.

```bash
terraform output -raw deploy_role_arn   | gh secret set AWS_DEPLOY_ROLE_ARN
terraform output -raw state_bucket_name | gh secret set TF_STATE_BUCKET
gh secret set SITE_DOMAIN     # prompts; enter the hostname, e.g. <sub>.yoschwab.com
gh secret list
```

`SITE_DOMAIN` must equal `site_domain` in `terraform.tfvars`. The deploy role may create DNS records and request a certificate for that name only.

## 5. Create and push `prod`

Pushing `prod` runs the deploy workflow, so do this when `main` is ready to go live (M2 for an early deploy, or M5).

```bash
git switch main
git pull --ff-only
git switch -c prod
git push -u origin prod
git switch main
```

Later releases promote `main` to `prod` with `git push origin main:prod`. Roll back with `git revert` on `prod` (00-build §9).

The first deploy takes about 10 to 20 minutes, most of it certificate validation and distribution creation. Follow it with `gh run watch`.

The deploy role trusts every push to `prod`. Consider a branch protection rule or ruleset on `prod` so that only you can push to it.

## 6. What the deploy workflow runs

This section is the spec for `.github/workflows/deploy.yml` (WP I3).

**Inputs.**

| Name | Source | Used as |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | Secret | `role-to-assume` for `aws-actions/configure-aws-credentials` |
| `TF_STATE_BUCKET` | Secret | `terraform init -backend-config="bucket=..."` |
| `SITE_DOMAIN` | Secret | The `TF_VAR_site_domain` environment variable |
| Region | Fixed | `us-east-1`, for the credentials action and the AWS CLI |

**Outputs of `infra/site`**, read with `terraform output -raw <name>` after apply.

| Output | Used for |
|---|---|
| `site_bucket_name` | `aws s3 sync` target |
| `cloudfront_distribution_id` | `aws cloudfront create-invalidation` |
| `site_url` | Job summary; `BASE_URL` for the smoke test against the live site (X5) |
| `log_bucket_name` | Not used by the workflow. The author uses it to check that logs arrive (X5). |

**Jobs.**

- `ci`: calls `ci.yml` (`uses: ./.github/workflows/ci.yml`, `permissions: contents: read`), so a deploy runs exactly the checks every push runs: install, lint, typecheck, test, build, the production-CSP smoke test, and Terraform fmt/validate. It has no AWS access and no `id-token`. Its `verify` job uploads `dist/`, the same build the smoke test served, as the `dist` artifact.
- `deploy`: `needs: ci`, with `permissions: { id-token: write, contents: read }`. It downloads `dist/` and runs the commands below.
  - Any step in a job with `id-token: write` can mint a token for the role. Keeping `pnpm install` and the build in the other job keeps dependency install scripts away from AWS.
  - Never cancel a deploy in progress. A cancelled apply can leave the state locked.
  - Don't give the job an `environment:`. That changes the OIDC subject to `...:environment:<name>`, and the role refuses it.
  - Set `terraform_wrapper: false` on `hashicorp/setup-terraform` (pin `terraform_version: 1.10.5`). The wrapper adds output that breaks `$(terraform output -raw ...)`.
- The workflow sets `concurrency: { group: deploy-prod, cancel-in-progress: false }` at the top level, so a whole deploy run, checks included, waits for the one before it.

**Commands**, after checkout, the `dist/` download, `setup-terraform`, and `configure-aws-credentials` (with `mask-aws-account-id: true`). No third-party action runs after the credentials exist. The workflow also adds `--no-progress` to each sync and `--query Invalidation.Id --output text` to the invalidation, to keep the logs short.

```bash
# The repo is public, so its Actions logs are too. Plan output contains ARNs;
# mask the account ID in them. GitHub already masks the secret values.
echo "::add-mask::$(aws sts get-caller-identity --query Account --output text)"

export TF_IN_AUTOMATION=1 TF_INPUT=0
export TF_VAR_site_domain="$SITE_DOMAIN"

terraform -chdir=infra/site init -backend-config="bucket=$TF_STATE_BUCKET"
terraform -chdir=infra/site plan -out=tfplan      # immediately before apply (K20)
terraform -chdir=infra/site apply tfplan

BUCKET=$(terraform -chdir=infra/site output -raw site_bucket_name)
DIST_ID=$(terraform -chdir=infra/site output -raw cloudfront_distribution_id)

# 1. Upload new hashed assets first, so the new index.html never points at a
#    file that isn't there yet.
aws s3 sync dist/assets "s3://$BUCKET/assets" \
  --cache-control "public, max-age=31536000, immutable"

# 2. Upload everything else, index.html included. Browsers and CloudFront
#    revalidate these on every request.
aws s3 sync dist "s3://$BUCKET" --exclude "assets/*" --delete \
  --cache-control "no-cache"

# 3. Invalidate the entry point, under both of the paths that viewers request.
aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths "/index.html" "/"

# 4. Remove assets that the new build no longer references.
aws s3 sync dist/assets "s3://$BUCKET/assets" --delete \
  --cache-control "public, max-age=31536000, immutable"
```

Notes for I3:

- The cache policy sets min TTL 0 and honors each object's `Cache-Control`. The two values above are the whole caching design (06 §6). An object uploaded without `Cache-Control` isn't cached at the edge.
- 06 §4 names only `/index.html` for invalidation. `/` is added because viewers request the root URL, and AWS doesn't document whether invalidating `/index.html` also clears it. Both are no-cache and revalidated anyway, so the invalidation is a backstop. The author decides whether to keep `/`.
- `aws s3 sync` sets `Content-Type` from the file extension. With `X-Content-Type-Options: nosniff`, the browser refuses a script or stylesheet served with the wrong type.
- CI validation (`ci.yml`, no AWS):

  ```bash
  terraform fmt -check -recursive infra
  terraform -chdir=infra/bootstrap init -backend=false -input=false
  terraform -chdir=infra/bootstrap validate
  terraform -chdir=infra/site init -backend=false -input=false
  terraform -chdir=infra/site validate
  ```

  `validate` also checks `infra/site/headers.json`. A header that `headers.tf` doesn't map fails it.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The token's subject doesn't match the trust policy: the immutable-subject prefix, an `environment:` on the job, or a branch other than `prod` | Compare `terraform output deploy_subject` in `infra/bootstrap` with step 1's `sub_claim_prefix`. Fix `github_oidc_subject_prefix` and re-apply bootstrap. |
| `AccessDenied` for some action during plan or apply | The deploy role lacks that permission | Add the action to `infra/bootstrap/deploy_policy.tf`, apply bootstrap locally, then `gh run rerun <run-id> --failed`. |
| `Error acquiring the state lock` | An earlier run died while holding the lock | Make sure no deploy is running. Then, with your own credentials: `terraform -chdir=infra/site init -backend-config="bucket=<state bucket>"` and `terraform -chdir=infra/site force-unlock <lock ID from the error>`. |
| Certificate validation times out | A CAA record blocks Amazon, or the zone isn't the public `yoschwab.com` zone in this account | See step 1, item 3. |
| `ci / verify` fails at `pnpm e2e` | A CSP violation, console error, or unexpected request in the production build | Download the `playwright-report` artifact from the run; its `requests.txt` attachment lists every request. |
| `headers.json: ... has no mapping in headers.tf` | A new header in `headers.json` | Add its lower-case name to `custom_header_names` in `headers.tf`, or map it to a structured field. |

## Changing things later

- **Response headers.** Edit `infra/site/headers.json`. The next deploy applies it, and the smoke test serves the same file.
- **Site hostname.** Set the new `site_domain` in `infra/bootstrap/terraform.tfvars` and re-apply bootstrap first. Then update the `SITE_DOMAIN` secret and push `prod`. The site apply replaces the certificate and DNS records.
- **Narrow the deploy role to one distribution (optional).** By default the role can manage any CloudFront distribution in the account, because the distribution's ID doesn't exist until the first deploy. Afterwards, set `site_distribution_id` in `infra/bootstrap/terraform.tfvars` to the `cloudfront_distribution_id` output, and re-apply bootstrap. If a later change ever replaces the distribution, unset it, re-apply bootstrap, deploy, and set it again.
