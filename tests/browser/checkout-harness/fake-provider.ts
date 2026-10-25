// Test-only: runs the suite's in-process fake Hyperswitch (tests/fakes) on the
// loopback port the harnessed app is pointed at, plus a small loopback control
// port for a manual check:
//   POST /set-status?payment_id=..&status=..   move a payment's status
//   GET  /calls                                every request the fake received
//   GET  /payments                             id, status, client_secret of each
// Nothing here contacts a real service.

import { createServer } from "node:http";
import { FakeHyperswitch } from "../../fakes/hyperswitch";
import { TEST_HYPERSWITCH_PORT } from "../../setup/constants";

const CONTROL_PORT = 38172;

async function main() {
  const fake = new FakeHyperswitch();
  await fake.start(TEST_HYPERSWITCH_PORT);

  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (body: unknown) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (req.method === "POST" && url.pathname === "/set-status") {
      const payment = fake.getPayment(url.searchParams.get("payment_id") ?? "");
      if (!payment) return void res.writeHead(404).end("no such payment");
      payment.status = url.searchParams.get("status") ?? payment.status;
      return json({ payment_id: payment.payment_id, status: payment.status });
    }
    if (url.pathname === "/calls") return json(fake.calls.map((c) => `${c.method} ${c.path}`));
    if (url.pathname === "/payments") {
      return json(
        fake.allPayments().map((p) => ({
          payment_id: p.payment_id,
          status: p.status,
          client_secret: p.client_secret,
        }))
      );
    }
    res.writeHead(404).end();
  }).listen(CONTROL_PORT, "127.0.0.1");

  console.log(`fake provider on ${TEST_HYPERSWITCH_PORT}, control on ${CONTROL_PORT}`);
}

main();
