provider "aws" {
  # CloudFront needs its ACM certificate in us-east-1, and standard logging v2
  # is configured through the us-east-1 CloudWatch Logs API. The buckets live
  # there too, so one provider covers the whole stack.
  region = "us-east-1"

  default_tags {
    tags = {
      Project    = "inference-simulator"
      Stack      = "site"
      ManagedBy  = "terraform"
      Repository = "yosyp/inference-simulator"
    }
  }
}
