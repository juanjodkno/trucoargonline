// public/sw.js

const CACHE_NAME = 'truco-argentino-static-v1';


self.addEventListener('install', () => {

  // Activa la nueva versión sin esperar
  self.skipWaiting();

});


self.addEventListener('activate', (event) => {

  event.waitUntil(

    Promise.all([

      // Borra cachés viejos de versiones anteriores
      caches.keys().then((keys) => {

        return Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith('truco-argentino-') &&
                key !== CACHE_NAME
            )
            .map((key) => caches.delete(key))
        );

      }),

      // Toma control inmediatamente de la página
      self.clients.claim()

    ])

  );

});


self.addEventListener('fetch', (event) => {

  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }


  const url = new URL(request.url);


  // No interceptamos contenido externo
  if (url.origin !== self.location.origin) {
    return;
  }


  /*
    API y Socket.IO jamás deben cachearse.
    Siempre deben trabajar contra el servidor real.
  */
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/')
  ) {
    return;
  }


  /*
    HTML / navegación:
    RED PRIMERO.

    Esto hace que al abrir nuevamente la app
    tome el index.html nuevo después de cada deploy.
  */
  if (request.mode === 'navigate') {

    event.respondWith(

      fetch(request, {
        cache: 'no-store'
      })

        .then((response) => {

          const copy = response.clone();

          caches
            .open(CACHE_NAME)
            .then((cache) => {
              cache.put(request, copy);
            })
            .catch(() => {});

          return response;

        })

        .catch(async () => {

          const cached =
            await caches.match(request);

          if (cached) {
            return cached;
          }

          const home =
            await caches.match('/');

          if (home) {
            return home;
          }

          return new Response(
            'Sin conexión a internet.',
            {
              status: 503,
              headers: {
                'Content-Type':
                  'text/plain; charset=utf-8'
              }
            }
          );

        })

    );

    return;
  }


  /*
    Imágenes, audios, cartas, etc.

    Si ya están guardados se muestran rápido,
    pero mientras tanto se comprueba si existe
    una versión más nueva.
  */
  event.respondWith(

    caches.match(request).then((cached) => {

      const networkRequest = fetch(request)

        .then((response) => {

          if (
            response &&
            response.status === 200 &&
            response.type === 'basic'
          ) {

            const copy =
              response.clone();

            caches
              .open(CACHE_NAME)
              .then((cache) => {
                cache.put(request, copy);
              })
              .catch(() => {});

          }

          return response;

        })

        .catch(() => cached);


      return cached || networkRequest;

    })

  );

});