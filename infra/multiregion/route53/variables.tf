variable "zone_id" {
  description = "Existing public Route53 hosted zone id."
  type        = string
}

variable "global_chat_name" {
  description = "Global application hostname."
  type        = string
}

variable "primary_origin_name" {
  description = "Primary regional ingress hostname."
  type        = string
}

variable "secondary_origin_name" {
  description = "Secondary regional ingress hostname."
  type        = string
}

variable "media_name" {
  description = "Global LiveKit media hostname."
  type        = string
}

variable "media_regions" {
  description = "LiveKit regional endpoints keyed by stable region name."
  type = map(object({
    aws_region = string
    dns_name   = string
  }))
}
