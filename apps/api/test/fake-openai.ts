import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OpenAiRequest {
  model: string;
  schema: string;
  system: string;
  user: string;
  authorization: string | undefined;
}

/**
 * A local stand-in for the OpenAI Chat Completions API. Answers follow simple keyword rules so
 * tests are deterministic, and every request is recorded so tests can check exactly what was
 * (and was not) sent.
 */
export class FakeOpenAi {
  private server!: Server;
  readonly requests: OpenAiRequest[] = [];
  /** Next N calls fail with this HTTP status. */
  failNext: { status: number; count: number } | null = null;

  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { model: string; messages: { role: string; content: string }[]; response_format?: { json_schema?: { name: string } } };
        const r: OpenAiRequest = {
          model: body.model,
          schema: body.response_format?.json_schema?.name ?? '',
          system: body.messages?.find((m) => m.role === 'system')?.content ?? '',
          user: body.messages?.find((m) => m.role === 'user')?.content ?? '',
          authorization: req.headers.authorization,
        };
        this.requests.push(r);
        if (this.failNext && this.failNext.count > 0) {
          this.failNext.count--;
          res.writeHead(this.failNext.status, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'fake failure' } }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: `${body.model}-fake`, choices: [{ message: { content: JSON.stringify(this.answer(r)) } }], usage: { prompt_tokens: Math.ceil(r.user.length / 4), completion_tokens: 50 } }));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this;
  }

  get baseUrl() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  private answer(r: OpenAiRequest): unknown {
    const text = r.user.toLowerCase();
    if (r.schema === 'thread_insights') {
      const quote = /quote|pricing|proposal|seo services|website redesign/.test(text);
      const angry = /refund|unacceptable|angry|complaint/.test(text);
      return {
        summary: quote ? 'A potential client asks for a quote for SEO services.' : angry ? 'A client is unhappy and asks for a refund.' : 'A general message.',
        category: quote ? 'SALES_ENQUIRY' : angry ? 'SUPPORT' : 'OTHER',
        sentiment: angry ? 'NEGATIVE' : 'POSITIVE',
        urgency: { level: angry || /urgent|asap/.test(text) ? 'URGENT' : 'NORMAL', reason: angry ? 'Complaint with a refund request' : 'No deadline given' },
        lead: { isLead: quote, confidence: quote ? 0.92 : 0.05, serviceInterest: quote ? 'SEO' : null, companyName: quote ? 'Acme' : null, reason: quote ? 'Asks for a quote' : 'Not a sales enquiry' },
        followUp: { needed: quote, inDays: quote ? 2 : null, action: quote ? 'Send the proposal' : null },
      };
    }
    if (r.schema === 'reply_suggestion') return { body: `Dear client,\n\nThank you for your message. We will send the details by [date].\n\nKind regards` };
    if (r.schema === 'rewrite') return { text: r.system.includes('grammar') ? r.user.replace(/\bteh\b/g, 'the').replace(/\bi\b/g, 'I') : `Dear customer,\n\n${r.user}` };
    return {};
  }

  stop() {
    this.server.close();
  }
}
