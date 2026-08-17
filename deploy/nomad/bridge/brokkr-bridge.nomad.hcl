# Brokkr bridge (the "spoke") on Nomad - one job per zone, on the site node
# next to the bare metal. Connects back to the hub's Redis bus only.
# Run: nomad job run -var-file=brokkr-bridge.nomadvars brokkr-bridge.nomad.hcl

variable "image" {
  type        = string
  default     = "hydrahost/brokkr-bridge:latest"
  description = "Bridge container image (BROKKR_BRIDGE_IMAGE in the Compose contract)."
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

variable "bridge_port" {
  type        = number
  default     = 8000
  description = "HTTP port the bridge binds on the node (BRIDGE_PORT in the Compose contract; the check follows it)."
}

variable "env_var_path" {
  type        = string
  default     = "nomad/jobs/brokkr-bridge"
  description = "Nomad Variable path holding the env contract (see bridge.env.example)."
}

variable "node_constraint" {
  type        = string
  default     = ""
  description = "Optional node name pinning the bridge to the site node wired to the metal (empty = any node)."
}

variable "cpu" {
  type    = number
  default = 1000
}

variable "memory" {
  type    = number
  default = 1024
}

job "brokkr-bridge" {
  datacenters = var.datacenters
  namespace   = var.namespace
  node_pool   = var.node_pool
  type        = "service"

  meta {
    env_var_path = var.env_var_path
  }

  dynamic "constraint" {
    for_each = var.node_constraint == "" ? [] : [var.node_constraint]
    content {
      attribute = "${node.unique.name}"
      value     = constraint.value
    }
  }

  # One bridge per zone; HA is disabled in this posture.
  group "bridge" {
    count = 1

    restart {
      attempts = 5
      interval = "10m"
      delay    = "15s"
      mode     = "delay"
    }

    # PXE/DHCP/TFTP and the VRRP floating IP must live on the node's real NICs,
    # so the bridge shares the host network stack (binds var.bridge_port directly).
    network {
      mode = "host"

      port "http" {
        static = var.bridge_port
      }
    }

    service {
      name     = "brokkr-bridge"
      port     = "http"
      provider = "nomad"

      check {
        type     = "http"
        path     = "/api/health"
        port     = "http"
        interval = "10s"
        timeout  = "5s"

        check_restart {
          limit = 12
          grace = "120s"
        }
      }
    }

    task "bridge" {
      driver       = "docker"
      kill_timeout = "30s"

      config {
        image        = var.image
        network_mode = "host"
        # VRRP adds the floating IP via `ip addr add`, which needs NET_ADMIN -
        # the client's docker plugin must include it in allow_caps.
        cap_add = ["NET_ADMIN"]

        # Empty strings = anonymous pull (the driver skips empty auth).
        auth {
          username = var.registry_auth_username
          password = var.registry_auth_password
        }
      }

      # Stack defaults mirroring the compose environment block; the contract
      # knobs come from the Nomad Variable (bridge.env.tpl) and win on conflict.
      env {
        ENVIRONMENT                  = "dev"
        LOCAL_SIMULATION_ENABLED     = "true"
        GRPC_INSECURE                = "true"
        PORT                         = var.bridge_port
        HOST                         = "0.0.0.0"
        GRPC_INTERNAL_HOST           = "0.0.0.0"
        BRIDGE_ORCHESTRATOR_ENABLED  = "true"
        REDIS_ENABLED                = "true"
        MTLS_ENABLED                 = "false"
        VPN_ENABLED                  = "false"
        REGISTER_BRIDGE              = "false"
        HA_ENABLED                   = "false"
        HEARTBEAT_ENABLED            = "true"
        ANALYTICS_ENABLED            = "false"
        IPXE_BUILD_ENABLED           = "false"
        CIFS_ENABLED                 = "false"
        MONITORING_LOGS_ENABLED      = "false"
        DISABLE_STARTUP_COORDINATION = "true"
        IPXE_SKIP_BUILD_LOCKING      = "true"
        JOB_STORAGE_BACKEND          = "redis"
        LOG_LEVEL                    = "debug"
        LOG_FORMAT                   = "console"
      }

      template {
        data        = file("bridge.env.tpl")
        destination = "secrets/bridge.env"
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
