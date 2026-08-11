provider "aws" {}

resource "aws_route53_health_check" "primary" {
  fqdn              = var.primary_origin_name
  port              = 443
  type              = "HTTPS"
  resource_path     = "/api/traffic-ready"
  request_interval  = 10
  failure_threshold = 3
  enable_sni        = true
  tags = {
    Name = "youtbelimo-primary-ready"
  }
}

resource "aws_route53_health_check" "secondary" {
  fqdn              = var.secondary_origin_name
  port              = 443
  type              = "HTTPS"
  resource_path     = "/api/traffic-ready"
  request_interval  = 10
  failure_threshold = 3
  enable_sni        = true
  tags = {
    Name = "youtbelimo-secondary-ready"
  }
}

resource "aws_route53_record" "chat_primary" {
  zone_id         = var.zone_id
  name            = var.global_chat_name
  type            = "CNAME"
  ttl             = 30
  set_identifier  = "primary"
  health_check_id = aws_route53_health_check.primary.id
  records         = [var.primary_origin_name]
  failover_routing_policy {
    type = "PRIMARY"
  }
}

resource "aws_route53_record" "chat_secondary" {
  zone_id         = var.zone_id
  name            = var.global_chat_name
  type            = "CNAME"
  ttl             = 30
  set_identifier  = "secondary"
  health_check_id = aws_route53_health_check.secondary.id
  records         = [var.secondary_origin_name]
  failover_routing_policy {
    type = "SECONDARY"
  }
}

resource "aws_route53_record" "media_latency" {
  for_each       = var.media_regions
  zone_id        = var.zone_id
  name           = var.media_name
  type           = "CNAME"
  ttl            = 30
  set_identifier = each.key
  records        = [each.value.dns_name]
  latency_routing_policy {
    region = each.value.aws_region
  }
}
