# Brokkr hub on Nomad - the control plane on ONE cluster. Postgres + Redis run
# as prestart sidecar tasks in the same alloc (toggleable to external), the hub
# image applies migrations on start. Run: nomad job run -var-file=brokkr-hub.nomadvars brokkr-hub.nomad.hcl

variable "image" {
  type        = string
  default     = "hydrahost/brokkr-hub:latest"
  description = "Hub container image (BROKKR_APP_IMAGE in the Compose contract)."
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

variable "hub_port" {
  type        = number
  default     = 3000
  description = "Host port publishing the hub API (HUB_HOST_PORT in the Compose contract)."
}

variable "redis_port" {
  type        = number
  default     = 6379
  description = "Host port publishing Redis - the hub<->bridge bus (REDIS_HOST_PORT in the Compose contract)."
}

variable "bundled_datastores" {
  type        = bool
  default     = true
  description = "Run Postgres + Redis as sidecar tasks. Set false to bring your own - then point DATABASE_URL/REDIS_URL in the Nomad Variable at them."
}

variable "env_var_path" {
  type        = string
  default     = "nomad/jobs/brokkr-hub"
  description = "Nomad Variable path holding the env contract (see hub.env.example)."
}

variable "service_tags" {
  type        = list(string)
  default     = []
  description = "Extra tags on the hub service - e.g. your ingress/router registration tags."
}

variable "cpu" {
  type    = number
  default = 1000
}

variable "memory" {
  type    = number
  default = 2048
}

job "brokkr-hub" {
  datacenters = var.datacenters
  namespace   = var.namespace
  node_pool   = var.node_pool
  type        = "service"

  meta {
    env_var_path = var.env_var_path
  }

  update {
    max_parallel      = 1
    min_healthy_time  = "30s"
    healthy_deadline  = "15m"
    progress_deadline = "20m"
    auto_revert       = true
  }

  # One alloc = the compose "hub machine": app + datastores share a network
  # namespace, so the sidecars are reachable on 127.0.0.1.
  group "hub" {
    count          = 1
    shutdown_delay = "10s"

    restart {
      attempts = 5
      interval = "10m"
      delay    = "15s"
      mode     = "delay"
    }

    # Best-effort persistence for the trial posture (survives in-place
    # restarts, migrates with the alloc). Use external datastores for real data.
    ephemeral_disk {
      sticky  = true
      migrate = true
      size    = 5120
    }

    network {
      mode = "bridge"

      port "http" {
        static = var.hub_port
        to     = 3000
      }

      dynamic "port" {
        for_each = var.bundled_datastores ? [1] : []
        labels   = ["redis"]
        content {
          static = var.redis_port
          to     = 6379
        }
      }
    }

    service {
      name     = "brokkr-hub"
      port     = "http"
      provider = "nomad"

      tags = var.service_tags

      check {
        type     = "http"
        path     = "/healthcheck"
        port     = "http"
        interval = "10s"
        timeout  = "5s"

        check_restart {
          limit = 10
          grace = "120s"
        }
      }
    }

    dynamic "task" {
      for_each = var.bundled_datastores ? [1] : []
      labels   = ["postgres"]
      content {
        driver = "docker"

        lifecycle {
          hook    = "prestart"
          sidecar = true
        }

        config {
          image = "postgres:16-alpine"
          ports = []
        }

        env {
          POSTGRES_USER     = "thor"
          POSTGRES_PASSWORD = "password"
          POSTGRES_DB       = "thor"
          PGDATA            = "/alloc/data/pgdata"
        }

        resources {
          cpu    = 500
          memory = 512
        }
      }
    }

    dynamic "task" {
      for_each = var.bundled_datastores ? [1] : []
      labels   = ["redis"]
      content {
        driver = "docker"

        lifecycle {
          hook    = "prestart"
          sidecar = true
        }

        config {
          image = "redis:7-alpine"
          args  = ["redis-server", "--dir", "/alloc/data"]
        }

        resources {
          cpu    = 200
          memory = 256
        }
      }
    }

    # Completes only once both sidecars accept connections, so the hub (whose
    # entrypoint runs `prisma migrate deploy` with no retry) never races them.
    dynamic "task" {
      for_each = var.bundled_datastores ? [1] : []
      labels   = ["wait-for-datastores"]
      content {
        driver = "docker"

        lifecycle {
          hook = "prestart"
        }

        config {
          image   = "postgres:16-alpine"
          command = "sh"
          args    = ["-c", "until pg_isready -h 127.0.0.1 -U thor -d thor; do sleep 2; done; until nc -z 127.0.0.1 6379; do sleep 2; done"]
        }

        resources {
          cpu    = 100
          memory = 64
        }
      }
    }

    task "hub" {
      driver       = "docker"
      kill_timeout = "30s"

      config {
        image = var.image
        ports = ["http"]

        # Empty strings = anonymous pull (the driver skips empty auth).
        auth {
          username = var.registry_auth_username
          password = var.registry_auth_password
        }
      }

      # The env contract, rendered verbatim from the Nomad Variable.
      template {
        data        = file("hub.env.tpl")
        destination = "secrets/brokkr.env"
        env         = true
        change_mode = "restart"
      }

      resources {
        cpu    = var.cpu
        memory = var.memory
      }
    }
  }
}
