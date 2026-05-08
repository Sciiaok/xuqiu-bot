import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import { defaultLocale, locales } from './i18n/config';
import { config as appConfig } from '@/src/config';
import { FOUNDER_TENANT_ID } from '@/lib/founder-id';

const PROTECTED_PREFIXES = [
  '/analytics',
  '/reports',
  '/product-lines',
  '/ai-automation',
  '/campaign-studio',
  '/leadhub',
  '/knowledge-base',
  '/admin',
  '/dev-tools',
  '/settings',
];

// 仅 founder 可访问的路径前缀。普通租户被 redirect 到 /analytics。
const FOUNDER_ONLY_PREFIXES = ['/admin', '/dev-tools'];

export async function proxy(request) {
  const pathname = request.nextUrl.pathname;

  if (process.env.PLAYWRIGHT_TEST === '1') {
    return NextResponse.next();
  }

  // Demo mode: skip auth, redirect login entrypoint to default page
  if (process.env.DEMO_MODE === 'true') {
    if (pathname === '/login') {
      const url = request.nextUrl.clone();
      url.pathname = '/analytics';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // --- Locale detection & cookie ---
  let response = NextResponse.next({ request });
  const localeCookie = request.cookies.get('NEXT_LOCALE')?.value;

  if (!localeCookie || !locales.includes(localeCookie)) {
    const acceptLang = request.headers.get('accept-language') || '';
    const preferred = acceptLang.split(',').map(l => l.split(';')[0].trim().substring(0, 2));
    const detected = preferred.find(l => locales.includes(l)) || defaultLocale;

    response = NextResponse.next({ request });
    response.cookies.set('NEXT_LOCALE', detected, { path: '/', maxAge: 365 * 24 * 60 * 60 });
  }

  const isProtectedRoute = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );

  if (!isProtectedRoute) {
    return response;
  }

  let supabaseResponse = response;

  const supabase = createServerClient(
    appConfig.supabase.url,
    appConfig.supabase.publishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          if (!localeCookie || !locales.includes(localeCookie)) {
            const acceptLang = request.headers.get('accept-language') || '';
            const preferred = acceptLang.split(',').map(l => l.split(';')[0].trim().substring(0, 2));
            const detected = preferred.find(l => locales.includes(l)) || defaultLocale;
            supabaseResponse.cookies.set('NEXT_LOCALE', detected, { path: '/', maxAge: 365 * 24 * 60 * 60 });
          }
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    const redirectResponse = NextResponse.redirect(url);
    // 保留 supabase-ssr 在 refresh 失败时写入的清 cookie 指令，
    // 避免下一次请求继续用同一份失效 refresh_token 触发 AuthApiError。
    supabaseResponse.cookies.getAll().forEach((c) => {
      redirectResponse.cookies.set(c.name, c.value, c);
    });
    return redirectResponse;
  }

  const isFounderOnlyRoute = FOUNDER_ONLY_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
  if (isFounderOnlyRoute) {
    const { data: profile } = await supabase
      .from('users')
      .select('tenant_id')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.tenant_id !== FOUNDER_TENANT_ID) {
      const url = request.nextUrl.clone();
      url.pathname = '/analytics';
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/analytics/:path*',
    '/reports/:path*',
    '/product-lines/:path*',
    '/ai-automation/:path*',
    '/campaign-studio/:path*',
    '/leadhub/:path*',
    '/knowledge-base/:path*',
    '/admin/:path*',
    '/dev-tools/:path*',
    '/settings/:path*',
    '/login',
  ],
};
