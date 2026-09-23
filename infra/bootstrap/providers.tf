provider "aws" {
  # Same region as infra/site. CloudFront, its certificate, and standard
  # logging v2 all live in us-east-1.
  region = "us-east-1"

  default_tags {
    tags = {
      Project    = "inference-simulator"
      Stack      = "bootstrap"
      ManagedBy  = "terraform"
      Repository = "yosyp/inference-simulator"
    }
  }
}
