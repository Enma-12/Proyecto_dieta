/* ---------------------------------------------------------------------------
   NutriCost · motor de gestos táctiles
   ---------------------------------------------------------------------------
   Reconoce gestos con Pointer Events (ratón, dedo y lápiz) y los emite como
   CustomEvent en el propio elemento:

       nutricost:swipe      detail = { direction, distance, velocity }
       nutricost:longpress  detail = { x, y, target }
       nutricost:pinch      detail = { scale, centroid }
       nutricost:doubletap  detail = { x, y, target }

   No depende de librerías externas. La intención vertical/horizontal se
   controla con `touch-action` en CSS para no romper el scroll de la página.
   --------------------------------------------------------------------------- */

(function (global) {
    "use strict";

    const DEFAULTS = {
        swipe: true,
        swipeDistance: 60,
        swipeMaxTime: 600,
        swipeAxisRatio: 1.5,
        longPress: true,
        longPressDelay: 450,
        moveTolerance: 10,
        pinch: true,
        pinchThreshold: 0.15,
        doubleTap: true,
        doubleTapDelay: 300,
        doubleTapDistance: 30,
    };

    function distancia(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function centro(a, b) {
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    function attach(element, options = {}) {
        if (!element) return function noop() {};

        const cfg = { ...DEFAULTS, ...options };
        const punteros = new Map();
        let inicio = null;
        let temporizadorLargo = null;
        let distanciaPinch = null;
        let ultimoTap = null;
        let ultimoTipoPuntero = "mouse";

        const emitir = (nombre, detail) => {
            element.dispatchEvent(
                new CustomEvent(`nutricost:${nombre}`, { detail })
            );
        };

        function cancelarPulsacion() {
            if (temporizadorLargo) {
                clearTimeout(temporizadorLargo);
                temporizadorLargo = null;
            }
        }

        function onPointerDown(event) {
            if (event.pointerType === "mouse" && event.button !== 0) return;

            ultimoTipoPuntero = event.pointerType;
            punteros.set(event.pointerId, { x: event.clientX, y: event.clientY });

            // Un segundo dedo convierte la interacción en pinch: se anulan
            // tap, doble tap y pulsación larga.
            if (punteros.size === 2) {
                cancelarPulsacion();
                inicio = null;
                if (cfg.pinch) {
                    const [a, b] = [...punteros.values()];
                    distanciaPinch = distancia(a, b) || 1;
                }
                return;
            }

            if (punteros.size !== 1) return;

            inicio = {
                x: event.clientX,
                y: event.clientY,
                tiempo: Date.now(),
                movido: false,
                pulsado: false,
            };

            if (cfg.longPress) {
                cancelarPulsacion();
                const origen = event;
                temporizadorLargo = setTimeout(() => {
                    if (!inicio || inicio.movido || punteros.size !== 1) return;
                    inicio.pulsado = true;
                    emitir("longpress", {
                        x: origen.clientX,
                        y: origen.clientY,
                        target: origen.target,
                    });
                }, cfg.longPressDelay);
            }
        }

        function onPointerMove(event) {
            if (!punteros.has(event.pointerId)) return;
            punteros.set(event.pointerId, { x: event.clientX, y: event.clientY });

            if (punteros.size === 2 && cfg.pinch) {
                const [a, b] = [...punteros.values()];
                const actual = distancia(a, b) || 1;
                const escala = actual / (distanciaPinch || actual);

                if (Math.abs(escala - 1) > cfg.pinchThreshold) {
                    emitir("pinch", { scale: escala, centroid: centro(a, b) });
                    // Se reinicia la base para permitir zoom continuo.
                    distanciaPinch = actual;
                }
                return;
            }

            if (inicio) {
                const movido = Math.hypot(
                    event.clientX - inicio.x,
                    event.clientY - inicio.y
                );
                if (movido > cfg.moveTolerance) {
                    inicio.movido = true;
                    cancelarPulsacion();
                }
            }
        }

        function terminarPuntero(event, cancelado) {
            if (!punteros.has(event.pointerId)) return;
            punteros.delete(event.pointerId);

            if (punteros.size < 2) distanciaPinch = null;

            if (punteros.size > 0 || cancelado || !inicio) {
                cancelarPulsacion();
                if (punteros.size === 0) inicio = null;
                return;
            }

            const dx = event.clientX - inicio.x;
            const dy = event.clientY - inicio.y;
            const duracion = Date.now() - inicio.tiempo;
            const recorrido = Math.hypot(dx, dy);

            cancelarPulsacion();

            if (!inicio.pulsado && !inicio.movido && cfg.doubleTap) {
                const ahora = Date.now();
                const esDoble =
                    ultimoTap &&
                    ahora - ultimoTap.tiempo <= cfg.doubleTapDelay &&
                    distancia(ultimoTap, {
                        x: event.clientX,
                        y: event.clientY,
                    }) <= cfg.doubleTapDistance;

                if (esDoble) {
                    ultimoTap = null;
                    emitir("doubletap", {
                        x: event.clientX,
                        y: event.clientY,
                        target: event.target,
                    });
                } else {
                    ultimoTap = {
                        tiempo: ahora,
                        x: event.clientX,
                        y: event.clientY,
                    };
                }
            }

            const esSwipe =
                cfg.swipe &&
                !inicio.pulsado &&
                recorrido >= cfg.swipeDistance &&
                duracion <= cfg.swipeMaxTime;

            if (esSwipe) {
                const horizontal =
                    Math.abs(dx) >= Math.abs(dy) * cfg.swipeAxisRatio;
                const vertical =
                    Math.abs(dy) >= Math.abs(dx) * cfg.swipeAxisRatio;

                if (horizontal || vertical) {
                    const direction = horizontal
                        ? dx < 0
                            ? "left"
                            : "right"
                        : dy < 0
                          ? "up"
                          : "down";

                    emitir("swipe", {
                        direction,
                        distance: recorrido,
                        velocity: recorrido / Math.max(duracion, 1),
                    });
                }
            }

            inicio = null;
        }

        const onPointerUp = (event) => terminarPuntero(event, false);
        const onPointerCancel = (event) => terminarPuntero(event, true);

        // En táctil, la pulsación larga dispararía el menú contextual del
        // navegador (selección de texto / vista previa del enlace).
        const onContextMenu = (event) => {
            if (cfg.longPress && ultimoTipoPuntero !== "mouse") {
                event.preventDefault();
            }
        };

        // pointerdown en el elemento; move/up en window para no perder el
        // gesto cuando el dedo sale del elemento (sin pointer capture, que
        // interferiría con los sliders nativos).
        element.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
        element.addEventListener("contextmenu", onContextMenu);

        return function detach() {
            element.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerCancel);
            element.removeEventListener("contextmenu", onContextMenu);
            cancelarPulsacion();
        };
    }

    global.NutriGestures = { attach };
})(window);
