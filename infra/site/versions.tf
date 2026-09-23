terraform {
  # 1.10 adds native S3 state locking (use_lockfile).
  required_version = "~> 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # The bucket is supplied at init time so the repo never names it:
  #   terraform init -backend-config="bucket=$TF_STATE_BUCKET"
  # The deploy role can read and write only this key and its lock file
  # (infra/bootstrap/deploy_policy.tf).
  backend "s3" {
    key          = "site/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
