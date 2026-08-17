# Optional one-shot `prisma migrate deploy` batch job for gated migrations
# (external database + RUN_DB_MIGRATIONS=false on the hub). Not needed by
# default: the hub image applies migrations in its entrypoint on every start.

variable "image" {
  type    = string
  default = "hydrahost/brokkr-hub:latest"
}

variable "registry_auth_username" {
  type        = string
  default     = ""
  description = "Optional docker registry username for private images (with registry_auth_password)."
}

variable "registry_auth_password" {
  type        = string
  default     = ""
  description = "Optional docker registry password/token for private images."
}

variable "namespace" {
  type    = string
  default = "default"
}

variable "node_pool" {
  type    = string
  default = "default"
}

variable "datacenters" {
  type    = list(string)
  default = ["*"]
}

variable "env_var_path" {
  type        = string
  default     = "nomad/jobs/brokkr-migrate"
  description = "Nomad Variable path holding at least DATABASE_URL."
}

job "brokkr-migrate" {
  datacenters = var.datacenters
  namespace   = var.namespace
  node_pool   = var.node_pool
  type        = "batch"

  meta {
    env_var_path = var.env_var_path
  }

  group "migrate" {
    count = 1

    # A failed migration must surface immediately, not retry-loop.
    restart {
      attempts = 0
      mode     = "fail"
    }

    reschedule {
      attempts  = 0
      unlimited = false
    }

    task "migrate" {
      driver = "docker"

      config {
        image      = var.image
        entrypoint = ["sh", "-c"]
        args       = ["cd /app/packages/database && /app/node_modules/.bin/prisma migrate deploy"]

        # Empty strings = anonymous pull (the driver skips empty auth).
        auth {
          username = var.registry_auth_username
          password = var.registry_auth_password
        }
      }

      template {
        data        = file("hub.env.tpl")
        destination = "secrets/brokkr.env"
        env         = true
        change_mode = "noop"
      }

      resources {
        cpu    = 500
        memory = 512
      }
    }
  }
}
