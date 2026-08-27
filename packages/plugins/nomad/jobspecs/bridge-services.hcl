# Generic Brokkr bridge-services–equivalent job. Public-safe: no Hydra registry,
# Vault, or PKI. Operators supply images and placement via Nomad variables.
# Job label is literal (HCL forbids interpolation in block labels); set Job.ID via
# the plugin request `variables.job_name` after parse.

variable "namespace" {
  type        = string
  default     = "default"
  description = "Nomad namespace for the job."
}

variable "datacenter" {
  type        = string
  description = "Target Nomad datacenter / placement constraint (required)."
}

variable "node_pool" {
  type        = string
  default     = "default"
  description = "Nomad node pool."
}

variable "zone_id" {
  type        = string
  description = "Brokkr zone identifier passed into bridge tasks (required)."
}

variable "bridge_api_image" {
  type        = string
  description = "Full docker image ref for bridge-api (required)."
}

variable "bind_image" {
  type        = string
  description = "Full docker image ref for bind9/DNS (required)."
}

variable "kea_image" {
  type        = string
  description = "Full docker image ref for kea-dhcp (required)."
}

variable "priority" {
  type        = number
  default     = 80
  description = "Nomad job priority."
}

job "bridge-services" {
  namespace   = var.namespace
  datacenters = [var.datacenter]
  type        = "system"
  priority    = var.priority
  node_pool   = var.node_pool

  update {
    max_parallel      = 1
    health_check      = "checks"
    min_healthy_time  = "30s"
    healthy_deadline  = "5m"
    progress_deadline = "10m"
    auto_revert       = true
  }

  group "dns" {
    network {
      mode = "host"
      port "dns" {
        static = 53
      }
    }

    restart {
      attempts = 10
      delay    = "30s"
      interval = "5m"
      mode     = "delay"
    }

    service {
      name     = "bind9"
      provider = "nomad"
      tags     = ["bind9", "dns", var.datacenter]
      port     = "dns"
      address  = "${attr.unique.network.ip-address}"

      check {
        type     = "tcp"
        name     = "bind9-dns-health"
        interval = "10s"
        timeout  = "3s"
      }
    }

    task "bind9" {
      driver = "docker"

      config {
        image        = var.bind_image
        network_mode = "host"
        cap_add      = ["net_bind_service"]
      }

      env {
        BROKKR_ZONE_ID = var.zone_id
      }

      resources {
        cpu    = 2000
        memory = 2048
      }

      kill_timeout = "15s"
    }
  }

  group "api" {
    network {
      mode = "host"

      port "api" {
        static = 80
      }
    }

    restart {
      attempts = 10
      delay    = "30s"
      interval = "5m"
      mode     = "delay"
    }

    task "bridge-api" {
      driver = "docker"

      config {
        image        = var.bridge_api_image
        network_mode = "host"
      }

      env {
        BROKKR_ZONE_ID = var.zone_id
        LOG_LEVEL      = "info"
        HOST           = "0.0.0.0"
        PORT           = "${NOMAD_PORT_api}"
      }

      service {
        name     = "bridge-api"
        port     = "api"
        address  = "${attr.unique.network.ip-address}"
        provider = "nomad"
        tags     = ["bridge-api", "api", var.datacenter]

        check {
          type     = "http"
          name     = "bridge-api-health"
          path     = "/api/health"
          interval = "10s"
          timeout  = "5s"
        }
      }

      resources {
        cpu    = 2000
        memory = 4096
      }

      kill_timeout = "15s"
    }
  }

  group "dhcp" {
    network {
      mode = "host"
      port "kea-api" {
        static = 11111
      }
    }

    restart {
      attempts = 10
      delay    = "30s"
      interval = "5m"
      mode     = "delay"
    }

    service {
      name     = "kea-dhcp"
      port     = "kea-api"
      address  = "${attr.unique.network.ip-address}"
      provider = "nomad"
      tags     = ["kea", "dhcp", var.datacenter]

      check {
        type     = "tcp"
        name     = "kea-dhcp-api-health"
        interval = "10s"
        timeout  = "3s"
        port     = 11111
      }
    }

    task "kea-dhcp4" {
      driver = "docker"

      config {
        image        = var.kea_image
        network_mode = "host"
        privileged   = true
        cap_add      = ["net_raw", "net_admin", "net_bind_service"]
      }

      env {
        BROKKR_ZONE_ID = var.zone_id
        KEA_API_PORT   = "11111"
      }

      resources {
        cpu    = 1000
        memory = 1024
      }

      kill_timeout = "15s"
    }
  }
}
