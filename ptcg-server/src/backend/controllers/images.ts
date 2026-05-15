import { Request, Response } from 'express';
import * as https from 'https';
import * as http from 'http';
import { Controller, Get } from './controller';
import { config } from '../../config';

export class Images extends Controller {
  private limitlessCardImageUrlCache: { [key: string]: string } = {};

  @Get('/proxy')
  public async onProxy(req: Request, res: Response) {
    const rawUrl = req.query.url;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      res.status(400).send('Missing or invalid url parameter');
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      res.status(400).send('Invalid URL format');
      return;
    }

    const protocol = parsed.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      res.status(400).send('Only http and https URLs are allowed');
      return;
    }

    const origin = `${parsed.protocol}//${parsed.host}`;
    const allowedOrigins = config.sets.imageProxyAllowedOrigins || [];
    const isAllowed = allowedOrigins.some(allowed => origin === allowed || origin.startsWith(allowed + '/'));
    if (!isAllowed) {
      res.status(400).send('URL origin not in allowlist');
      return;
    }

    const client = protocol === 'https:' ? https : http;
    client.get(parsed.toString(), (upstreamRes) => {
      if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
        res.status(502).send('Upstream fetch failed');
        return;
      }

      const contentType = upstreamRes.headers['content-type'];
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      const cacheControl = upstreamRes.headers['cache-control'];
      if (cacheControl) {
        res.setHeader('Cache-Control', cacheControl);
      }

      upstreamRes.pipe(res);
    }).on('error', (err) => {
      console.warn('[Images proxy] Upstream fetch error:', err.message);
      if (!res.headersSent) {
        res.status(502).send('Upstream fetch failed');
      }
    });
  }

  @Get('/card')
  public async onCard(req: Request, res: Response) {
    const set = typeof req.query.set === 'string' ? req.query.set.trim().toUpperCase() : '';
    const number = typeof req.query.number === 'string' ? req.query.number.trim() : '';

    if (!set || !number || !/^[A-Z0-9]+$/.test(set) || !/^[A-Za-z0-9-]+$/.test(number)) {
      res.status(400).send('Missing or invalid set/number');
      return;
    }

    const cacheKey = `${set}/${number}`;

    try {
      const imageUrl = this.limitlessCardImageUrlCache[cacheKey]
        || await this.resolveLimitlessCardImageUrl(set, number);

      if (!imageUrl) {
        res.status(404).send('Card image not found');
        return;
      }

      this.limitlessCardImageUrlCache[cacheKey] = imageUrl;
      this.pipeImage(imageUrl, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[Images card] Image resolution failed:', message);
      if (!res.headersSent) {
        res.status(502).send('Card image resolution failed');
      }
    }
  }

  private async resolveLimitlessCardImageUrl(set: string, number: string): Promise<string> {
    const pageUrl = `https://limitlesstcg.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`;
    const html = await this.fetchText(pageUrl);
    const patterns = [
      /href=["'](https:\/\/limitlesstcg\.nyc3\.cdn\.digitaloceanspaces\.com\/[^"']+?\.png)["']/i,
      /src=["'](https:\/\/limitlesstcg\.nyc3\.cdn\.digitaloceanspaces\.com\/[^"']+?\.png)["']/i
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        return match[1].replace(/&amp;/g, '&');
      }
    }

    return '';
  }

  private fetchText(url: string, redirects = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;

      client.get(parsed.toString(), upstreamRes => {
        const statusCode = upstreamRes.statusCode || 0;
        const location = upstreamRes.headers.location;

        if (statusCode >= 300 && statusCode < 400 && location && redirects < 3) {
          upstreamRes.resume();
          const nextUrl = new URL(location, parsed).toString();
          this.fetchText(nextUrl, redirects + 1).then(resolve, reject);
          return;
        }

        if (statusCode >= 400) {
          upstreamRes.resume();
          reject(new Error(`Upstream fetch failed with ${statusCode}`));
          return;
        }

        upstreamRes.setEncoding('utf8');
        let body = '';
        upstreamRes.on('data', chunk => { body += chunk; });
        upstreamRes.on('end', () => { resolve(body); });
      }).on('error', reject);
    });
  }

  private pipeImage(url: string, res: Response, redirects = 0): void {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    client.get(parsed.toString(), upstreamRes => {
      const statusCode = upstreamRes.statusCode || 0;
      const location = upstreamRes.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location && redirects < 3) {
        upstreamRes.resume();
        const nextUrl = new URL(location, parsed).toString();
        this.pipeImage(nextUrl, res, redirects + 1);
        return;
      }

      if (statusCode >= 400) {
        upstreamRes.resume();
        if (!res.headersSent) {
          res.status(502).send('Upstream image fetch failed');
        }
        return;
      }

      const contentType = upstreamRes.headers['content-type'];
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.setHeader('Access-Control-Allow-Origin', '*');

      upstreamRes.pipe(res);
    }).on('error', err => {
      console.warn('[Images card] Upstream image fetch error:', err.message);
      if (!res.headersSent) {
        res.status(502).send('Upstream image fetch failed');
      }
    });
  }
}
