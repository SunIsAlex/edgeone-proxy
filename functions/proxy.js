export async function onRequest(context) {
    const { request } = context;
    try {
        const requestUrl = new URL(request.url);
        const targetUrlParam = requestUrl.searchParams.get('url');

        if (!targetUrlParam) {
            return new Response("Query parameter 'url' is missing.", { status: 400 });
        }

        const targetUrl = new URL(targetUrlParam);
        const proxyBase = `${requestUrl.origin}/proxy?url=`;

        const forwardHeaders = new Headers(request.headers);
        forwardHeaders.set('Host', targetUrl.host);
        forwardHeaders.set('Origin', targetUrl.origin);
        forwardHeaders.set('Referer', targetUrl.origin + '/');
        // 关键：告诉目标服务器不要压缩，避免解码问题
        forwardHeaders.set('Accept-Encoding', 'identity');
        forwardHeaders.delete('CF-Connecting-IP');
        forwardHeaders.delete('CF-Ray');
        forwardHeaders.delete('X-Forwarded-For');
        forwardHeaders.delete('X-Real-IP');

        const proxyRequest = new Request(targetUrl.toString(), {
            method: request.method,
            headers: forwardHeaders,
            body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
            redirect: 'follow',
        });

        const response = await fetch(proxyRequest);

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', '*');
        responseHeaders.delete('Content-Security-Policy');
        responseHeaders.delete('Content-Security-Policy-Report-Only');
        responseHeaders.delete('X-Frame-Options');
        // 关键：无论什么响应，都删除 Content-Encoding
        // 因为 fetch() 已经自动解压，响应体是明文，不能再让浏览器二次解压
        responseHeaders.delete('Content-Encoding');
        // 同理删除 Content-Length，解压后长度已变，原值会导致截断
        responseHeaders.delete('Content-Length');

        const contentType = responseHeaders.get('Content-Type') || '';

        if (contentType.includes('text/html')) {
            let html = await response.text();
            html = rewriteHtml(html, targetUrl, proxyBase);

            const interceptScript = `
<script>
(function() {
    const PROXY_BASE = ${JSON.stringify(proxyBase)};
    const TARGET_ORIGIN = ${JSON.stringify(targetUrl.origin)};

    function toProxyUrl(url) {
        if (!url || url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('#') || url.startsWith('blob:')) return url;
        try {
            const abs = new URL(url, TARGET_ORIGIN).href;
            if (abs.startsWith(location.origin)) return abs;
            return PROXY_BASE + encodeURIComponent(abs);
        } catch(e) { return url; }
    }

    document.addEventListener('click', function(e) {
        const a = e.target.closest('a');
        if (a && a.href && !a.href.startsWith(PROXY_BASE)) {
            const proxied = toProxyUrl(a.href);
            if (proxied !== a.href) {
                e.preventDefault();
                window.location.href = proxied;
            }
        }
    }, true);

    const origAssign = window.location.assign.bind(window.location);
    const origReplace = window.location.replace.bind(window.location);
    window.location.assign = (url) => origAssign(toProxyUrl(url));
    window.location.replace = (url) => origReplace(toProxyUrl(url));

    const origFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') input = toProxyUrl(input);
        else if (input instanceof Request) input = new Request(toProxyUrl(input.url), input);
        return origFetch(input, init);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        return origOpen.call(this, method, toProxyUrl(url), ...rest);
    };
})();
</script>`;

            if (html.includes('<head>')) {
                html = html.replace('<head>', '<head>' + interceptScript);
            } else {
                html = interceptScript + html;
            }

            responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
            return new Response(html, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
            });
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
        });

    } catch (error) {
        return new Response(`Proxy Error: ${error.message}`, { status: 500 });
    }
}

function rewriteHtml(html, targetUrl, proxyBase) {
    const base = targetUrl.origin;

    function toProxy(url) {
        if (!url) return url;
        url = url.trim();
        if (url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('#') || url.startsWith('blob:')) return url;
        try {
            const abs = new URL(url, base).href;
            return proxyBase + encodeURIComponent(abs);
        } catch(e) { return url; }
    }

    html = html.replace(
        /(<(?:img|script|link|iframe|audio|video|source|input|form)[^>]*?\s(?:src|href|action)=)(["'])([^"']+)\2/gi,
        (match, prefix, quote, url) => `${prefix}${quote}${toProxy(url)}${quote}`
    );

    html = html.replace(
        /(<(?:img|source)[^>]*?\ssrcset=)(["'])([^"']+)\2/gi,
        (match, prefix, quote, srcset) => {
            const rewritten = srcset.replace(/([^\s,]+)(\s*(?:\d+[wx])?)/g, (m, url, descriptor) => {
                return toProxy(url) + descriptor;
            });
            return `${prefix}${quote}${rewritten}${quote}`;
        }
    );

    html = html.replace(/url\((['"]?)([^)'"\s]+)\1\)/gi, (match, quote, url) => {
        return `url(${quote}${toProxy(url)}${quote})`;
    });

    return html;
}
