/**
 * EdgeOne Pages 反向代理函数
 * 直接由边缘节点代理请求，透传用户 Cookie 及请求头
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

        // 构建透传请求头：复制用户原始请求头，并修正 Host/Origin/Referer
        const forwardHeaders = new Headers(request.headers);
        forwardHeaders.set('Host', targetUrl.host);
        forwardHeaders.set('Origin', targetUrl.origin);
        forwardHeaders.set('Referer', targetUrl.origin + '/');

        // 移除可能暴露代理身份的头
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

        // 处理响应头：透传大部分头，但修正跨域和安全策略
        const responseHeaders = new Headers(response.headers);

        // 放开跨域，允许前端正常接收响应
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', '*');

        // 移除会阻止代理页面正常渲染的安全头
        responseHeaders.delete('Content-Security-Policy');
        responseHeaders.delete('Content-Security-Policy-Report-Only');
        responseHeaders.delete('X-Frame-Options');

        // Cookie 透传（保留但移除 Secure/SameSite 限制以兼容跨域场景）
        // 注意：如需完整 Cookie 隔离，可在此处直接 delete('Set-Cookie')
        // responseHeaders.delete('Set-Cookie');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
        });

    } catch (error) {
        return new Response(`Proxy Error: ${error.message}`, { status: 500 });
    }
}
