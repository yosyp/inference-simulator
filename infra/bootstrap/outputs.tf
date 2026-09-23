output "deploy_role_arn" {
  description = "Value for the AWS_DEPLOY_ROLE_ARN secret."
  value       = aws_iam_role.deploy.arn
}

output "state_bucket_name" {
  description = "Value for the TF_STATE_BUCKET secret, and the bucket this stack's own state migrates to."
  value       = aws_s3_bucket.state.id
}

output "deploy_subject" {
  description = "The GitHub OIDC subject the deploy role trusts."
  value       = local.deploy_subject
}
