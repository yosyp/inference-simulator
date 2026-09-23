terraform {
  # 1.10 adds native S3 state locking (use_lockfile).
  required_version = "~> 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # The first apply runs with local state: infra/README.md step 2 has you create
  # a gitignored backend_override.tf that swaps this block for a local backend.
  # Step 3 deletes the override and migrates the state here. The bucket is
  # supplied at init time:
  #   terraform init -backend-config="bucket=<state bucket name>"
  # The state bucket policy denies the deploy role everything under bootstrap/.
  backend "s3" {
    key          = "bootstrap/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
