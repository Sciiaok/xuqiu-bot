import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import { defaultLocale, locales } from './i18n/config';

export async function middleware(request) {
  const pathname = request.nextUrl.pathname;

  if (process.env.PLAYWRIGHT_TEST === '1') {
    return NextResponse.next();
  }

  // Demo mode: skip auth, redirect auth entrypoints to their default pages
  if (process.env.DEMO_MODE === 'true') {
    if (pathname === '/login') {
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard';
      return NextResponse.redirect(url);
    }
    if (pathname === '/v5/login') {
      const url = request.nextUrl.clone();
      url.pathname = '/v5/analytics';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // --- Locale detection & cookie ---
  let response = NextResponse.next({ request });
  const localeCookie = request.cookies.get('NEXT_LOCALE')?.value;

  if (!localeCookie || !locales.includes(localeCookie)) {
    // Try Accept-Language header
    const acceptLang = request.headers.get('accept-language') || '';
    const preferred = acceptLang.split(',').map(l => l.split(';')[0].trim().substring(0, 2));
    const detected = preferred.find(l => locales.includes(l)) || defaultLocale;

    response = NextResponse.next({ request });
    response.cookies.set('NEXT_LOCALE', detected, { path: '/', maxAge: 365 * 24 * 60 * 60 });
  }

  const isDashboardRoute = pathname.startsWith('/dashboard');
  const isV5Route = pathname.startsWith('/v5');
  const isV5LoginRoute = pathname === '/v5/login';
  const isProtectedRoute = isDashboardRoute || (isV5Route && !isV5LoginRoute);

  // Only protect app routes that require an authenticated Supabase session
  if (!isProtectedRoute) {
    return response;
  }

  let supabaseResponse = response;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
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
          // Re-apply locale cookie on supabase response
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
    url.pathname = isV5Route ? '/v5/login' : '/login';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/dashboard/:path*', '/login', '/v5/:path*'],
};
