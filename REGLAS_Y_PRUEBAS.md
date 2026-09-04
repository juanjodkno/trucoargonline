# Revisión del motor de Truco

## Validaciones realizadas

- Mazo español de 40 cartas y cartas únicas.
- Jerarquía argentina: 1 espada, 1 basto, 7 espada, 7 oro, 3, 2, ases falsos, 12, 11, 10, 7 falsos, 6, 5, 4.
- Comparación de cartas.
- Envido con dos cartas del mismo palo.
- Envido sin pareja de palo: mayor carta.
- Figuras 10/11/12 con valor 0 para Envido.
- Flor con tres cartas del mismo palo.
- Resolución de baza: dos bazas ganadas, primera parda, segunda parda y triple parda.
- Mano como desempate cuando las tres bazas son pardas.
- Bloqueo de jugada cuando la mano ya terminó.
- Bloqueo de jugada mientras existe una respuesta pendiente.
- Valores de Flor: Flor 3, Contraflor aceptada 6, Contraflor no querida 4 y Contraflor al juego según puntos restantes.
- Validación del Envido declarado contra los tantos reales del jugador; el cliente ya no puede declarar un número inventado.
- Protección de transición de mano para que un mismo cierre no programe dos repartos.
- Identificador de mano (`handId`) para rechazar acciones atrasadas de una mano anterior.
- `actionId` opcional para ignorar eventos duplicados enviados por Socket.IO.
- Aplicación idempotente de puntos por resolución de Envido, Flor, Truco y abandono.
- Validación de respuestas `Quiero/No quiero` y de la escalera Truco → Retruco → Vale 4.

## Prueba ejecutada

`npm run build` y `npm run test:rules` completan correctamente.

## Sobre GGTruco

La web pública de GGTruco permite acceder a la plataforma, pero su implementación interna y su reglamento completo no están expuestos públicamente. Por eso esta entrega no copia código propietario ni afirma reproducir funciones privadas de GGTruco. La lógica se ajustó a las reglas públicas del Truco Argentino y a los comportamientos que pueden verificarse públicamente.

## Corrección de transición de mano (2026-09-03)

Se corrigió un bloqueo en el cierre por `ME_VOY_AL_MAZO` / `NO_QUIERO_TRUCO`: ese camino llamaba a la transición sin marcar `gameRound.isFinished`, por lo que `handleRoundTransition()` rechazaba el reparto siguiente.

También se agregaron logs de transición y una prueba de regresión automática (`npm run test:transitions`) que verifica:
- cierre por mazo -> una sola mano siguiente;
- cierre normal por bazas -> una sola mano siguiente.


## Corrección de Retruco / Vale 4 (2026-09-03)

Se corrigió la escalera de cantos para permitir las respuestas válidas del Truco Argentino:
- `TRUCO -> RETRUCO` sin necesidad de decir `QUIERO` previamente;
- `RETRUCO -> VALE_4` sin necesidad de decir `QUIERO` previamente;
- si el Truco fue aceptado con `QUIERO`, quien lo aceptó queda habilitado para cantar Retruco cuando le corresponda;
- si el Retruco fue aceptado, quien lo aceptó queda habilitado para cantar Vale 4 cuando le corresponda;
- el jugador que hizo el canto anterior no puede auto-subirse el mismo canto después de ser aceptado;
- rechazar Truco/Retruco/Vale 4 otorga respectivamente 1/2/3 puntos;
- irse al mazo sin Envido/Flor cantados ya no agrega un punto de Envido inexistente.

Se agregó `npm run test:truco-calls` y se verificaron también `build`, `test:rules` y `test:transitions`.

El HTML/CSS visual no fue rediseñado. En `public/index.html` solo se añadió metadata interna (`handId`/`actionId`) a los eventos Socket.IO para descartar acciones duplicadas o atrasadas.
