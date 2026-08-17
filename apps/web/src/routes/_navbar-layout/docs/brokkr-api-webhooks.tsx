import { BRAND_NAME } from '@/lib/branding';
import { createFileRoute } from '@tanstack/react-router';
import { DocPage } from './_components/-docs-page';

export const Route = createFileRoute('/_navbar-layout/docs/brokkr-api-webhooks')({
  component: DocsBrokkrApiWebhooks,
});

function DocsBrokkrApiWebhooks() {
  return (
    <DocPage>
      <DocPage.Heading>
        <DocPage.SectionTitle>{BRAND_NAME} API</DocPage.SectionTitle>
        <DocPage.PageTitle>Webhooks</DocPage.PageTitle>
      </DocPage.Heading>

      <DocPage.Content>
        <h2 className="mb-4 text-2xl font-semibold">Overview</h2>
        <p>
          Webhooks allow you to receive real-time HTTP POST notifications when events occur in your {BRAND_NAME}{' '}
          organization. Instead of polling the API for changes, webhooks push data to your endpoint as events happen.
        </p>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">Available Events</h2>
        <p className="mb-4">Currently, webhooks support the following events:</p>
        <ul className="mb-6 list-inside list-disc space-y-2">
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">DEVICE_LISTING_CREATED</code> - When a
            new device is added to our inventory
          </li>
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">DEVICE_LISTING_UPDATED</code> - When
            device information or pricing is updated in our inventory
          </li>
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">DEVICE_LISTING_DECOMMISSIONED</code> -
            When a device is removed from our inventory
          </li>
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">DEPLOYMENT_INTERRUPTED</code> - When a
            deployment is interrupted
          </li>
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">
              DEPLOYMENT_INTERRUPTION_COMPLETED
            </code>{' '}
            - When a deployment interruption process has completed
          </li>
        </ul>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">Webhook Payload</h2>
        <p className="mb-4">
          All webhook events are delivered as HTTP POST requests with a JSON payload. The payload structure includes:
        </p>
        <pre className="bg-popover text-popover-foreground mb-6 overflow-x-auto rounded-lg p-4">
          {`{
    // Event-specific data
    data:{
      "id": "device-uuid",
      "name": "NVIDIA RTX 4090",
      "status": "on demand",
      // ... additional fields
      }
    // Event type
    eventType: "DEVICE_LISTING_CREATED",
    // Timestamp
    timestamp: "2021-01-01T00:00:00.000Z",
  },
 `}
        </pre>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">HTTP Headers</h2>
        <p className="mb-4">Each webhook request includes the following headers:</p>
        <ul className="mb-6 list-inside list-disc space-y-2">
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">X-Webhook-Signature</code> -
            HMAC-SHA256 signature for request verification
          </li>
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">X-Webhook-Event</code> - The event type
            (e.g., DEVICE_LISTING_CREATED)
          </li>
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">X-Webhook-Delivery</code> - Unique ID
            for this delivery attempt
          </li>
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">X-Webhook-Timestamp</code> - ISO 8601
            timestamp of when the webhook was sent
          </li>
          <li>
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">User-Agent</code> - Always set to "
            {BRAND_NAME}-Webhooks/1.0"
          </li>
        </ul>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">Signature Verification</h2>
        <p className="mb-4">
          To ensure webhook requests are coming from {BRAND_NAME}, you should verify the signature included in the
          <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-sm">X-Webhook-Signature</code> header.
        </p>

        <h3 className="mb-3 text-xl font-semibold">Verification Steps</h3>
        <ol className="mb-6 list-inside list-decimal space-y-2">
          <li>
            Extract the signature from the{' '}
            <code className="bg-secondary rounded px-1 py-0.5 font-mono text-sm">X-Webhook-Signature</code> header
          </li>
          <li>Compute an HMAC-SHA256 hash of the raw request body using your webhook secret</li>
          <li>Compare your computed signature with the received signature</li>
        </ol>

        <h3 className="mb-3 text-xl font-semibold">Example Implementation</h3>

        <h4 className="mt-4 mb-2 text-lg font-semibold">Node.js / JavaScript</h4>
        <pre className="bg-popover text-popover-foreground mb-6 overflow-x-auto rounded-lg p-4">
          {`const crypto = require('crypto');

function verifyWebhookSignature(body, signature, secret) {
  const expectedSignature = 'sha256=' + 
    crypto.createHmac('sha256', secret)
          .update(body, 'utf8')
          .digest('hex');
  
  // Use timingSafeEqual to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Express.js example
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const isValid = verifyWebhookSignature(req.body, signature, process.env.WEBHOOK_SECRET);
  
  if (!isValid) {
    return res.status(401).send('Invalid signature');
  }
  
  const event = JSON.parse(req.body);
  // Process the webhook event
  console.log('Received event:', event.eventType);
  
  res.status(200).send('OK');
});`}
        </pre>

        <h4 className="mb-2 text-lg font-semibold">Python</h4>
        <pre className="bg-popover text-popover-foreground mb-6 overflow-x-auto rounded-lg p-4">
          {`import hmac
import hashlib

def verify_webhook_signature(body: bytes, signature: str, secret: str) -> bool:
    expected_signature = 'sha256=' + hmac.new(
        secret.encode('utf-8'),
        body,
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(signature, expected_signature)

# Flask example
from flask import Flask, request, abort

app = Flask(__name__)

@app.route('/webhook', methods=['POST'])
def handle_webhook():
    signature = request.headers.get('X-Webhook-Signature')
    body = request.get_data()
    
    if not verify_webhook_signature(body, signature, os.environ['WEBHOOK_SECRET']):
        abort(401)
    
    event = request.get_json()
    print(f"Received event: {event['eventType']}")
    
    return 'OK', 200`}
        </pre>

        <h4 className="mb-2 text-lg font-semibold">Go</h4>
        <pre className="bg-popover text-popover-foreground mb-6 overflow-x-auto rounded-lg p-4">
          {`package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "io"
    "net/http"
)

func verifyWebhookSignature(body []byte, signature, secret string) bool {
    h := hmac.New(sha256.New, []byte(secret))
    h.Write(body)
    expectedSignature := "sha256=" + hex.EncodeToString(h.Sum(nil))
    
    return hmac.Equal([]byte(signature), []byte(expectedSignature))
}

func webhookHandler(w http.ResponseWriter, r *http.Request) {
    signature := r.Header.Get("X-Webhook-Signature")
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "Failed to read body", http.StatusBadRequest)
        return
    }
    
    if !verifyWebhookSignature(body, signature, os.Getenv("WEBHOOK_SECRET")) {
        http.Error(w, "Invalid signature", http.StatusUnauthorized)
        return
    }
    
    // Process the webhook
    fmt.Println("Webhook verified and received")
    w.WriteHeader(http.StatusOK)
}`}
        </pre>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">Retry Logic</h2>
        <p className="mb-4">{BRAND_NAME} implements automatic retry logic for failed webhook deliveries:</p>
        <ul className="mb-6 list-inside list-disc space-y-2">
          <li>Webhooks are retried up to 5 times with linear backoff</li>
          <li>Retry delays: 1, 2, 3, 4, and 5 minutes after each failure</li>
          <li>A webhook is considered successful if it returns a 2xx HTTP status code</li>
          <li>After 10 consecutive failures across multiple events, the webhook will be automatically disabled</li>
        </ul>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">Best Practices</h2>
        <ul className="mb-6 list-inside list-disc space-y-2">
          <li>
            <strong>Always verify signatures</strong> - This ensures requests are authentic and haven't been tampered
            with
          </li>
          <li>
            <strong>Respond quickly</strong> - Return a 2xx response as soon as possible (within 10 seconds)
          </li>
          <li>
            <strong>Process asynchronously</strong> - Queue events for processing rather than handling them
            synchronously
          </li>
          <li>
            <strong>Handle duplicates</strong> - Use the delivery ID to ensure idempotent processing
          </li>
          <li>
            <strong>Store the raw payload</strong> - Keep the original event data for debugging and reprocessing
          </li>
          <li>
            <strong>Monitor failures</strong> - Set up alerts for webhook failures in your system
          </li>
        </ul>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">Testing Webhooks</h2>
        <p className="mb-4">To test your webhook implementation:</p>
        <ol className="mb-6 list-inside list-decimal space-y-2">
          <li>
            Use a tool like{' '}
            <a
              href="https://webhook.site"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              webhook.site
            </a>{' '}
            to create a temporary endpoint
          </li>
          <li>Create a webhook pointing to your test endpoint</li>
          <li>Trigger events in your {BRAND_NAME} account (e.g., update device pricing)</li>
          <li>Verify the payload structure and test your signature verification</li>
        </ol>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">Webhook Management</h2>
        <p className="mb-4">You can manage webhooks through the {BRAND_NAME} dashboard or API:</p>
        <ul className="mb-6 list-inside list-disc space-y-2">
          <li>Create webhooks with specific event subscriptions</li>
          <li>View delivery history and debug failed deliveries</li>
          <li>Manually retry successful or failed deliveries</li>
          <li>Update endpoint URLs and event subscriptions</li>
          <li>Regenerate webhook secrets if compromised</li>
          <li>Temporarily disable webhooks during maintenance</li>
        </ul>

        <h2 className="mt-8 mb-4 text-2xl font-semibold">Security Considerations</h2>
        <ul className="mb-6 list-inside list-disc space-y-2">
          <li>Always use HTTPS endpoints to prevent man-in-the-middle attacks</li>
          <li>Store webhook secrets securely (use environment variables, not hardcoded values)</li>
          <li>Implement rate limiting on your webhook endpoint</li>
          <li>Log webhook requests for audit purposes</li>
          <li>Rotate webhook secrets periodically</li>
          <li>Validate the webhook payload structure and data types</li>
        </ul>
      </DocPage.Content>

      <DocPage.Footer>
        <DocPage.PreviousLink href="/docs/brokkr-api-reservations">API Reservations</DocPage.PreviousLink>
        <DocPage.NextLink href="/docs/brokkr-api-authentication">API Authentication</DocPage.NextLink>
      </DocPage.Footer>
    </DocPage>
  );
}
