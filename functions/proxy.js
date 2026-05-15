/**
 * EdgeOne Pages 反向代理函数
 * 支持 HTML 内链接重写，确保页面资源全部走代理
 */
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

        // 构建透传请求头
        const forwardHeaders = new Headers(request.headers);
        forwardHeaders.set('Host', targetUrl.host);
        forwardHeaders.set('Origin', targetUrl.origin);
        forwardHeaders.set('Referer', targetUrl.origin + '/');
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

        const contentType = responseHeaders.get('Content-Type') || '';

        // 只对 HTML 内容进行链接重写
        if (contentType.includes('text/html')) {
            let html = await response.text();
            html = rewriteHtml(html, targetUrl, proxyBase);

            // 注入一段 JS，拦截动态跳转和 fetch/XHR 请求
            const interceptScript = `
<script>
(function() {
    const PROXY_BASE = ${JSON.stringify(proxyBase)};
    const TARGET_ORIGIN = ${JSON.stringify(targetUrl.origin)};

    function toProxyUrl(url) {
        if (!url || url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('#') || url.startsWith('blob:')) return url;
        try {
            const abs = new URL(url, TARGET_ORIGIN).href;
            if (abs.startsWith(PROXY_BASE)) return abs; // 已经是代理链接
            return PROXY_BASE + encodeURIComponent(abs);
        } catch(e) { return url; }
    }

    // 拦截 a 标签点击跳转
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

    // 拦截 window.location 赋值
    const origAssign = window.location.assign.bind(window.location);
    const origReplace = window.location.replace.bind(window.location);
    window.location.assign = (url) => origAssign(toProxyUrl(url));
    window.location.replace = (url) => origReplace(toProxyUrl(url));

    // 拦截 fetch
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') input = toProxyUrl(input);
        else if (input instanceof Request) input = new Request(toProxyUrl(input.url), input);
        return origFetch(input, init);
    };

    // 拦截 XMLHttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        return origOpen.call(this, method, toProxyUrl(url), ...rest);
    };
})();
</script>`;

            // 注入到 <head> 最前面，确保尽早执行
            if (html.includes('<head>')) {
                html = html.replace('<head>', '<head>' + interceptScript);
            } else {
                html = interceptScript + html;
            }

            responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
            responseHeaders.delete('Content-Encoding'); // 已解码，移除压缩标记
            return new Response(html, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
            });
        }

        // 非 HTML 资源（CSS、JS、图片等）直接透传
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
        });

    } catch (error) {
        return new Response(`Proxy Error: ${error.message}`, { status: 500 });
    }
}

/**
 * 重写 HTML 中的静态资源链接
 */
function rewriteHtml(html, targetUrl, proxyBase) {
    const base = targetUrl.origin;

    // 将相对路径转为绝对路径再代理
    function toProxy(url) {
        if (!url) return url;
        url = url.trim();
        if (url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('#') || url.startsWith('blob:')) return url;
        try {
            const abs = new URL(url, base).href;
            return proxyBase + encodeURIComponent(abs);
        } catch(e) { return url; }
    }

    // 替换常见属性中的链接：src、href、action、srcset
    html = html.replace(
        /(<(?:img|script|link|iframe|audio|video|source|input|form)[^>]*?\s(?:src|href|action)=)(["'])([^"']+)\2/gi,
        (match, prefix, quote, url) => `${prefix}${quote}${toProxy(url)}${quote}`
    );

    // 处理 srcset（多个 URL）
    html = html.replace(
        /(<(?:img|source)[^>]*?\ssrcset=)(["'])([^"']+)\2/gi,
        (match, prefix, quote, srcset) => {
            const rewritten = srcset.replace(/([^\s,]+)(\s*(?:\d+[wx])?)/g, (m, url, descriptor) => {
                return toProxy(url) + descriptor;
            });
            return `${prefix}${quote}${rewritten}${quote}`;
        }
    );

    // 处理 CSS 内的 url()
    html = html.replace(/url\((['"]?)([^)'"\s]+)\1\)/gi, (match, quote, url) => {
        return `url(${quote}${toProxy(url)}${quote})`;
    });

    return html;
}
