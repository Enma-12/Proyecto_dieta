/* ---------------------------------------------------------------------------
   NutriCost · lógica del frontend
   ---------------------------------------------------------------------------
   - Carga los alimentos desde GET /alimentos y llena los multiselects.
   - Gestiona sliders y chips (estado activo).
   - Envía el perfil a POST /optimizar_perfil y renderiza la cesta óptima.
   --------------------------------------------------------------------------- */

"use strict";

const API_BASE = "http://127.0.0.1:5000";
const URL_ALIMENTOS = `${API_BASE}/alimentos`;
const URL_OPTIMIZAR = `${API_BASE}/optimizar_perfil`;

const MENSAJE_PRESUPUESTO_UI =
    "El presupuesto ingresado es insuficiente para cubrir los requerimientos de este perfil en el plazo seleccionado. Prueba aumentando el presupuesto o reduciendo el plazo.";

// Tasa BCV de referencia (editable). El cálculo de la dieta siempre se hace en
// USD; la tasa solo se usa para mostrar el equivalente en bolívares.
const TASA_POR_DEFECTO = 36.0;
const CLAVE_TASA = "nutricost.tasa";
const CLAVE_TASAS_ANTIGUA = "nutricost.tasas";
const CLAVE_PISTA = "nutricost.pistaGestos";

// Tope del presupuesto TOTAL según el plazo. El backend optimiza por día, así
// que el tope diario equivalente es 100 / 28,6 / 20 USD para 1 / 7 / 30 días.
const TOPES_PRESUPUESTO = { 1: 100, 7: 200, 30: 600 };

const state = {
    genero: "hombre",
    objetivo: "mantener",
    actividad: 1.55,
    plazo: 1,
    tasa: TASA_POR_DEFECTO,
    costoUSD: 0,
    obligatorios: new Set(),
    excluidos: new Set(),
};

const CHIP_ACTIVE = [
    "bg-emerald-600",
    "text-white",
    "ring-emerald-600",
    "shadow-sm",
];
const CHIP_INACTIVE = [
    "bg-white",
    "text-slate-600",
    "ring-slate-200",
    "hover:border-emerald-300",
    "hover:text-emerald-700",
];

const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
});

const numberFmt = (value, decimals = 0) =>
    new Intl.NumberFormat("es-VE", {
        maximumFractionDigits: decimals,
    }).format(Number(value) || 0);

const numeroBs = new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

const multiselects = {};
let ultimoResultado = null;
let macroChart = null;
let costoChart = null;
let cumplimientoChart = null;
let chartZoom = 1;
let toastTimer = null;

// A partir de este número de obligatorios es fácil que sus grasas o
// carbohidratos agoten los topes del perfil y el modelo quede infactible.
const LIMITE_OBLIGATORIOS = 5;

document.addEventListener("DOMContentLoaded", init);

function init() {
    bindSliders();
    bindChips();
    cargarTasa();
    bindTasa();
    actualizarTopePresupuesto();
    initMultiselect("obligatorios");
    initMultiselect("excluidos");
    initGestures();
    initSheet();
    initPaneles();
    initVistas();
    initPistaGestos();
    actualizarResumenAvanzadas();
    document.getElementById("btn-calcular").addEventListener("click", calcularDieta);
    cargarAlimentos();
}

/* ===========================================================================
   Sliders + inputs numéricos (sincronización bidireccional)
   =========================================================================== */
const GRUPOS_NUMERICOS = ["actividad", "plazo"];

function bindSliders() {
    document.querySelectorAll('input[type="range"]').forEach((range) => {
        const numero = document.getElementById(`${range.id}-val`);

        range.addEventListener("input", () => sincronizarDesdeSlider(range));

        if (numero) {
            // Mientras escribe no forzamos el rango: evita pelear con el teclado
            // (p. ej. al teclear "55" el "5" intermedio no debe saltar a 40).
            numero.addEventListener("input", () => aplicarValorDesdeNumero(range, numero, false));
            numero.addEventListener("change", () => aplicarValorDesdeNumero(range, numero, true));
            numero.addEventListener("blur", () => aplicarValorDesdeNumero(range, numero, true));
            numero.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    numero.blur();
                }
            });
        }

        sincronizarDesdeSlider(range);
    });
}

function esPresupuesto(range) {
    return range.id === "presupuesto";
}

function formatearValor(range, valor) {
    return esPresupuesto(range)
        ? Number(valor).toFixed(2)
        : String(Math.round(Number(valor)));
}

function actualizarRelleno(range) {
    const min = Number(range.min);
    const max = Number(range.max);
    const valor = Number(range.value);
    const porcentaje = max > min ? ((valor - min) / (max - min)) * 100 : 0;
    range.style.setProperty("--fill", `${Math.min(100, Math.max(0, porcentaje))}%`);
}

function sincronizarDesdeSlider(range) {
    const numero = document.getElementById(`${range.id}-val`);
    if (numero) {
        numero.value = formatearValor(range, range.value);
    }
    actualizarRelleno(range);
}

function aplicarValorDesdeNumero(range, numero, ajustar) {
    if (numero.value.trim() === "") {
        // Campo vacío: al confirmar (blur/change) restauramos el valor del slider.
        if (ajustar) sincronizarDesdeSlider(range);
        return;
    }

    let valor = Number(numero.value);
    if (!Number.isFinite(valor)) {
        if (ajustar) sincronizarDesdeSlider(range);
        return;
    }

    const min = Number(range.min);
    const max = Number(range.max);

    if (ajustar) {
        valor = Math.min(max, Math.max(min, valor));
    } else if (valor < min || valor > max) {
        // Fuera de rango mientras escribe: esperamos a que termine.
        return;
    }

    range.value = String(valor);
    actualizarRelleno(range);

    if (ajustar) {
        // El <input type="range"> ajusta al step: reflejamos su valor real.
        numero.value = formatearValor(range, range.value);
    }
}

/* ===========================================================================
   Chips
   =========================================================================== */
function bindChips() {
    document.querySelectorAll(".chip[data-group]").forEach((chip) => {
        chip.addEventListener("click", () => seleccionarChip(chip));
        aplicarEstadoChip(chip, chip.getAttribute("aria-pressed") === "true");
    });
}

function seleccionarChip(chip) {
    const grupo = chip.dataset.group;
    const valor = chip.dataset.value;

    state[grupo] = GRUPOS_NUMERICOS.includes(grupo) ? Number(valor) : valor;

    document.querySelectorAll(`.chip[data-group="${grupo}"]`).forEach((otro) => {
        aplicarEstadoChip(otro, otro === chip);
    });

    // Si ya hay una cesta en pantalla, refrescamos el multiplicador sin
    // volver a llamar al backend (que siempre trabaja a 1 día).
    if (grupo === "plazo") {
        // El presupuesto es el total del periodo: el tope crece con el plazo
        // para que los perfiles de muchas calorías sigan siendo alcanzables.
        actualizarTopePresupuesto();
        if (ultimoResultado) {
            renderResultados(ultimoResultado, { scroll: false });
        }
    }
}

function actualizarTopePresupuesto() {
    const plazo = Number(state.plazo) || 1;
    const tope = TOPES_PRESUPUESTO[plazo] ?? TOPES_PRESUPUESTO[1];

    const range = document.getElementById("presupuesto");
    const numero = document.getElementById("presupuesto-val");
    if (!range) return;

    range.max = String(tope);
    if (Number(range.value) > tope) {
        range.value = String(tope);
    }
    actualizarRelleno(range);

    if (numero) {
        numero.max = String(tope);
        if (Number(numero.value) > tope) {
            numero.value = formatearValor(range, range.value);
        }
    }
}

function aplicarEstadoChip(chip, activo) {
    chip.setAttribute("aria-pressed", String(activo));
    chip.classList.remove(...CHIP_ACTIVE, ...CHIP_INACTIVE);
    chip.classList.add(...(activo ? CHIP_ACTIVE : CHIP_INACTIVE));
}

/* ===========================================================================
   Tasa BCV (USD -> VES)
   =========================================================================== */
function tasaActiva() {
    return Number(state.tasa) || 0;
}

function formatearBs(valor) {
    return `Bs. ${numeroBs.format(Number(valor) || 0)}`;
}

function cargarTasa() {
    try {
        const guardada = Number(localStorage.getItem(CLAVE_TASA));
        if (Number.isFinite(guardada) && guardada > 0) {
            state.tasa = guardada;
        } else {
            // Migración desde la versión anterior (BCV / Paralelo): se conserva
            // la tasa BCV que el usuario ya tenía guardada.
            const antiguas = JSON.parse(
                localStorage.getItem(CLAVE_TASAS_ANTIGUA) || "null"
            );
            const bcv = Number(antiguas?.bcv);
            if (Number.isFinite(bcv) && bcv > 0) {
                state.tasa = bcv;
                guardarTasa();
            }
        }
    } catch (error) {
        // localStorage no disponible (modo privado) o JSON corrupto: se usa
        // el valor por defecto sin interrumpir la app.
        console.warn("No se pudo cargar la tasa guardada:", error);
    }

    actualizarTasaUI();
}

function guardarTasa() {
    try {
        localStorage.setItem(CLAVE_TASA, String(state.tasa));
    } catch (error) {
        console.warn("No se pudo guardar la tasa:", error);
    }
}

function actualizarTasaUI() {
    const input = document.getElementById("tasa-val");
    if (input) {
        input.value = tasaActiva() > 0 ? tasaActiva().toFixed(2) : "";
    }
    actualizarEtiquetaTasa();
}

function actualizarEtiquetaTasa() {
    const etiqueta = document.getElementById("res-tasa");
    if (!etiqueta) return;

    const tasa = tasaActiva();
    etiqueta.textContent =
        tasa > 0
            ? `Tasa BCV: ${numeroBs.format(tasa)} Bs./USD`
            : "Tasa BCV: sin definir";
}

function actualizarEquivalenteVES() {
    const salida = document.getElementById("res-costo-ves");
    if (!salida) return;

    const tasa = tasaActiva();
    salida.textContent = tasa > 0 ? formatearBs(state.costoUSD * tasa) : "—";

    actualizarEtiquetaTasa();
    actualizarResumenAvanzadas();
}

function bindTasa() {
    const input = document.getElementById("tasa-val");
    if (!input) return;

    input.addEventListener("input", () => {
        const valor = Number(input.value);
        // Campo vacío o inválido: el equivalente se muestra como "—" hasta
        // que el usuario escriba un número válido.
        if (input.value.trim() === "" || !Number.isFinite(valor) || valor <= 0) {
            state.tasa = 0;
            guardarTasa();
            actualizarEquivalenteVES();
            return;
        }

        state.tasa = valor;
        guardarTasa();
        actualizarEquivalenteVES();
    });

    input.addEventListener("blur", () => {
        // Al salir, normalizamos a 2 decimales o restauramos el valor por
        // defecto si el campo quedó vacío.
        if (!(Number(input.value) > 0)) {
            state.tasa = TASA_POR_DEFECTO;
            guardarTasa();
        }
        actualizarTasaUI();
        actualizarEquivalenteVES();
    });

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            input.blur();
        }
    });
}

/* ===========================================================================
   Multiselects
   =========================================================================== */
function initMultiselect(kind) {
    const cfg = {
        kind,
        root: document.querySelector(`[data-multiselect="${kind}"]`),
        toggle: document.getElementById(`${kind}-toggle`),
        panel: document.getElementById(`${kind}-panel`),
        list: document.getElementById(`${kind}-list`),
        search: document.getElementById(`${kind}-search`),
        label: document.getElementById(`${kind}-label`),
        chips: document.getElementById(`${kind}-chips`),
        other: kind === "obligatorios" ? "excluidos" : "obligatorios",
    };
    multiselects[kind] = cfg;

    cfg.toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePanel(kind);
    });
    cfg.panel.addEventListener("click", (event) => event.stopPropagation());
    cfg.search.addEventListener("input", () => filtrarLista(kind));

    renderSeleccion(kind);
}

function togglePanel(kind) {
    const cfg = multiselects[kind];
    const abrir = cfg.panel.classList.contains("hidden");

    cerrarPaneles();

    if (abrir) {
        cfg.panel.classList.remove("hidden");
        cfg.toggle.setAttribute("aria-expanded", "true");
        cfg.search.focus();
    }
}

function cerrarPaneles() {
    Object.values(multiselects).forEach((cfg) => {
        cfg.panel.classList.add("hidden");
        cfg.toggle.setAttribute("aria-expanded", "false");
    });
}

document.addEventListener("click", cerrarPaneles);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cerrarPaneles();
});

function llenarLista(kind, alimentos) {
    const cfg = multiselects[kind];
    cfg.list.replaceChildren();

    if (!alimentos.length) {
        const vacio = document.createElement("p");
        vacio.className = "px-2 py-3 text-sm text-slate-400";
        vacio.textContent = "No hay alimentos disponibles.";
        cfg.list.appendChild(vacio);
        return;
    }

    alimentos.forEach((nombre) => {
        const label = document.createElement("label");
        label.className =
            "flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-sm text-slate-700 transition hover:bg-slate-50";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = nombre;
        checkbox.className =
            "h-4 w-4 shrink-0 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500";

        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                state[kind].add(nombre);
                // Un alimento no puede estar en ambas listas.
                if (state[cfg.other].has(nombre)) {
                    state[cfg.other].delete(nombre);
                    sincronizarCheckbox(cfg.other, nombre, false);
                    renderSeleccion(cfg.other);
                }
            } else {
                state[kind].delete(nombre);
            }
            renderSeleccion(kind);
        });

        const texto = document.createElement("span");
        texto.className = "truncate";
        texto.textContent = nombre;

        label.append(checkbox, texto);
        cfg.list.appendChild(label);
    });
}

function sincronizarCheckbox(kind, nombre, marcado) {
    multiselects[kind].list.querySelectorAll('input[type="checkbox"]').forEach((box) => {
        if (box.value === nombre) {
            box.checked = marcado;
        }
    });
}

function renderSeleccion(kind) {
    const cfg = multiselects[kind];
    const nombres = [...state[kind]];

    if (nombres.length === 0) {
        cfg.label.textContent = "Ninguno seleccionado";
    } else if (nombres.length === 1) {
        cfg.label.textContent = nombres[0];
    } else {
        cfg.label.textContent = `${nombres.length} seleccionados`;
    }

    cfg.chips.replaceChildren();

    nombres.forEach((nombre) => {
        const chip = document.createElement("span");
        chip.className =
            "inline-flex max-w-full items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-100";

        const texto = document.createElement("span");
        texto.className = "truncate";
        texto.textContent = nombre;

        const quitar = document.createElement("button");
        quitar.type = "button";
        quitar.setAttribute("aria-label", `Quitar ${nombre}`);
        quitar.className = "shrink-0 text-emerald-600 transition hover:text-emerald-900";
        quitar.textContent = "×";
        quitar.addEventListener("click", () => {
            state[kind].delete(nombre);
            sincronizarCheckbox(kind, nombre, false);
            renderSeleccion(kind);
        });

        chip.append(texto, quitar);
        cfg.chips.appendChild(chip);
    });

    actualizarResumenAvanzadas();
    actualizarAvisoObligatorios();
}

function actualizarAvisoObligatorios() {
    const aviso = document.getElementById("obligatorios-aviso");
    if (!aviso) return;

    const total = state.obligatorios.size;
    if (total <= LIMITE_OBLIGATORIOS) {
        aviso.textContent = "";
        aviso.classList.add("hidden");
        return;
    }

    const seleccionados = [...state.obligatorios].join(", ");
    const maxRecomendado = 4;

    aviso.innerHTML = `
        <strong>⚠️ Tienes ${total} alimentos obligatorios seleccionados:</strong> ${seleccionados}.
        <br>Si el costo o los macronutrientes (grasas, carbohidratos, proteínas) superan tus límites, el sistema no podrá calcular la dieta.
        <br>Te recomendamos seleccionar <strong>máximo ${maxRecomendado}</strong>.
    `;
    aviso.classList.remove("hidden");
}

function filtrarLista(kind) {
    const cfg = multiselects[kind];
    const termino = cfg.search.value.trim().toLowerCase();

    cfg.list.querySelectorAll("label").forEach((label) => {
        const coincide = label.textContent.toLowerCase().includes(termino);
        label.classList.toggle("hidden", termino !== "" && !coincide);
    });
}

/* ===========================================================================
   API
   =========================================================================== */
async function cargarAlimentos() {
    try {
        const response = await fetch(URL_ALIMENTOS);
        if (!response.ok) {
            throw new Error("No se pudo cargar la lista de alimentos.");
        }
        const data = await response.json();
        const alimentos = Array.isArray(data.alimentos) ? data.alimentos : [];

        llenarLista("obligatorios", alimentos);
        llenarLista("excluidos", alimentos);
    } catch (error) {
        console.error("Error al cargar alimentos:", error);
        mostrarAlerta(
            "No se pudo cargar la lista de alimentos. Verifica que app.py esté ejecutándose en el puerto 5000."
        );
    }
}

function esErrorDePresupuesto(data) {
    if (!data || typeof data !== "object") return false;
    if (data.codigo === "presupuesto_insuficiente") return true;

    // Respaldo por si el backend no envía el código.
    const texto = `${data.mensaje || ""} ${data.error || ""}`;
    return /presupuesto/i.test(texto) && /insuficiente|no alcanza|insuficientes/i.test(texto);
}

function mensajeDeError(data, status) {
    if (esErrorDePresupuesto(data)) {
        const minimo = Number(data.costo_minimo_diario);
        if (Number.isFinite(minimo) && minimo > 0) {
            const plazo = Number(state.plazo) || 1;
            // El slider avanza de $1 en $1: redondeamos hacia arriba para que
            // el total sugerido sea realmente seleccionable.
            const total = Math.ceil(minimo * plazo);
            const periodo = plazo === 1 ? "1 día" : `${plazo} días`;
            return (
                "El presupuesto ingresado es insuficiente para cubrir los " +
                "requerimientos de este perfil en el plazo seleccionado. " +
                `Necesitas al menos ${money.format(minimo)}/día ` +
                `(${money.format(total)} para ${periodo}). ` +
                "Prueba aumentando el presupuesto o reduciendo el plazo."
            );
        }
        return MENSAJE_PRESUPUESTO_UI;
    }
    return data.mensaje || data.error || `Error ${status} al calcular la dieta.`;
}

async function calcularDieta() {
    ocultarAlerta();

    // El slider de presupuesto representa el TOTAL del periodo elegido, pero el
    // backend siempre optimiza para 1 día. Enviamos el equivalente diario para
    // que, al multiplicar por el plazo en pantalla, el costo no supere el total.
    const plazo = Number(state.plazo) || 1;
    const presupuestoTotal = Number(document.getElementById("presupuesto").value) || 0;

    const payload = {
        peso: Number(document.getElementById("peso").value),
        altura: Number(document.getElementById("altura").value),
        edad: Number(document.getElementById("edad").value),
        genero: state.genero,
        actividad: state.actividad,
        objetivo: state.objetivo,
        presupuesto_maximo: presupuestoTotal / plazo,
        alimentos_obligatorios: [...state.obligatorios],
        alimentos_excluidos: [...state.excluidos],
    };

    setCargando(true);

    try {
        const response = await fetch(URL_OPTIMIZAR, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(mensajeDeError(data, response.status));
        }

        if (data.estado !== "Optimal" || !Array.isArray(data.alimentos)) {
            throw new Error("La respuesta del servidor no tiene el formato esperado.");
        }

        // En móvil cambiamos a la pestaña de resultados antes de pintar:
        // Chart.js necesita el canvas visible para medir su tamaño.
        mostrarVista("resultados");
        renderResultados(data);
    } catch (error) {
        console.error("Error al optimizar:", error);
        const esConexion = error instanceof TypeError;
        mostrarAlerta(
            esConexion
                ? "No se pudo conectar con el servidor. Verifica que app.py esté ejecutándose en el puerto 5000."
                : error.message
        );
    } finally {
        setCargando(false);
    }
}

/* ===========================================================================
   Render
   =========================================================================== */
function renderResultados(data, { scroll = true } = {}) {
    ultimoResultado = data;

    // El backend siempre responde para 1 día: aquí aplicamos el plazo elegido
    // (1, 7 o 30) sobre costos, macros y porciones antes de pintar.
    const plazo = Number(state.plazo) || 1;
    const macro = data.resumen_nutricional || {};
    const escalar = (valor) => Math.round((Number(valor) || 0) * plazo * 100) / 100;

    state.costoUSD = escalar(data.costo_total);

    document.getElementById("res-costo").textContent = money.format(state.costoUSD);
    document.getElementById("res-periodo").textContent =
        plazo === 1 ? "Total para 1 día" : `Total para ${plazo} días`;
    actualizarEquivalenteVES();
    document.getElementById("res-calorias").textContent = `${numberFmt(escalar(macro.Calorias))} kcal`;
    document.getElementById("res-proteinas").textContent = `${numberFmt(escalar(macro.Proteinas))} g`;
    document.getElementById("res-carbohidratos").textContent = `${numberFmt(escalar(macro.Carbohidratos))} g`;
    document.getElementById("res-grasas").textContent = `${numberFmt(escalar(macro.Grasas))} g`;

    // Hacemos visible la zona antes de dibujar: Chart.js necesita medir el canvas.
    const results = document.getElementById("results");
    results.classList.remove("hidden");
    document.getElementById("resultados-vacio")?.classList.add("hidden");

    renderMacroChart({
        proteinas: escalar(macro.Proteinas),
        carbohidratos: escalar(macro.Carbohidratos),
        grasas: escalar(macro.Grasas),
    });
    renderCostoChart(data.alimentos, plazo);
    renderCumplimientoChart(data);

    const contenedor = document.getElementById("cards");
    contenedor.replaceChildren();

    data.alimentos.forEach((item, index) => {
        contenedor.appendChild(
            crearTarjeta(
                {
                    ...item,
                    porciones: escalar(item.porciones),
                    costo_subtotal: escalar(item.costo_subtotal),
                },
                index
            )
        );
    });

    if (scroll) {
        // En móvil ya estamos en la pestaña de resultados: basta con subir.
        // En escritorio desplazamos la columna derecha a la vista.
        const esEscritorio =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(min-width: 1024px)").matches;
        if (esEscritorio) {
            results.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    }
}

function renderMacroChart({ proteinas, carbohidratos, grasas }) {
    const canvas = document.getElementById("macroChart");
    if (!canvas) return;

    // Si el CDN de Chart.js no cargó, el resto de la interfaz sigue funcionando.
    if (typeof Chart === "undefined") {
        console.warn("Chart.js no está disponible; se omite el gráfico de macros.");
        return;
    }

    // Cada render (nuevo cálculo o cambio de plazo) recrea el gráfico.
    if (macroChart) {
        macroChart.destroy();
        macroChart = null;
    }

    // Gramos -> kcal: proteína 4, carbohidratos 4, grasas 9.
    const kcal = [
        Math.max(0, Number(proteinas) || 0) * 4,
        Math.max(0, Number(carbohidratos) || 0) * 4,
        Math.max(0, Number(grasas) || 0) * 9,
    ];

    macroChart = new Chart(canvas.getContext("2d"), {
        type: "doughnut",
        data: {
            labels: ["Proteínas", "Carbohidratos", "Grasas"],
            datasets: [
                {
                    data: kcal,
                    backgroundColor: ["#059669", "#34d399", "#065f46"],
                    borderColor: "#ffffff",
                    borderWidth: 2,
                    hoverOffset: 8,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "62%",
            animation: { duration: 450 },
            plugins: {
                legend: {
                    position: "bottom",
                    labels: {
                        usePointStyle: true,
                        pointStyle: "circle",
                        boxWidth: 8,
                        boxHeight: 8,
                        padding: 16,
                        color: "#475569",
                        font: { size: 11, weight: "600" },
                    },
                },
                tooltip: {
                    callbacks: {
                        label: (contexto) => {
                            const datos = contexto.dataset.data || [];
                            const total = datos.reduce((suma, valor) => suma + valor, 0) || 1;
                            const porcentaje = Math.round((contexto.parsed / total) * 100);
                            return ` ${contexto.label}: ${numberFmt(contexto.parsed)} kcal (${porcentaje}%)`;
                        },
                    },
                },
            },
        },
    });
}

/* ---------------------------------------------------------------------------
   Gráfico: ¿en qué se va el dinero? (costo por alimento)
   --------------------------------------------------------------------------- */
function renderCostoChart(alimentos, plazo) {
    const canvas = document.getElementById("costoChart");
    const wrap = document.getElementById("costo-wrap");
    const resumen = document.getElementById("costo-resumen");
    if (!canvas || !wrap) return;

    if (costoChart) {
        costoChart.destroy();
        costoChart = null;
    }

    const filas = (Array.isArray(alimentos) ? alimentos : [])
        .map((item) => ({
            nombre: item.alimento,
            costo: (Number(item.costo_subtotal) || 0) * plazo,
        }))
        .filter((fila) => fila.costo > 0)
        .sort((a, b) => b.costo - a.costo);

    if (filas.length === 0) {
        wrap.classList.add("hidden");
        if (resumen) resumen.textContent = "";
        return;
    }

    wrap.classList.remove("hidden");

    const total = filas.reduce((suma, fila) => suma + fila.costo, 0) || 1;
    const paleta = ["#059669", "#10b981", "#34d399", "#6ee7b7", "#a7f3d0", "#d1fae5"];

    if (resumen) {
        const top = filas[0];
        resumen.textContent =
            `El más caro: ${top.nombre} ` +
            `(${money.format(top.costo)}, ${Math.round((top.costo / total) * 100)}%)`;
    }

    wrap.style.height = `${Math.max(150, filas.length * 34 + 30)}px`;

    // Sin Chart.js el gráfico se omite, pero el resumen de arriba sigue visible.
    if (typeof Chart === "undefined") {
        wrap.classList.add("hidden");
        return;
    }

    const truncar = (texto) =>
        texto.length > 22 ? `${texto.slice(0, 21)}…` : texto;

    costoChart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels: filas.map((fila) => truncar(fila.nombre)),
            datasets: [
                {
                    data: filas.map((fila) => fila.costo),
                    backgroundColor: filas.map((_, i) => paleta[i % paleta.length]),
                    borderRadius: 6,
                    barThickness: 18,
                },
            ],
        },
        options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => filas[items[0].dataIndex].nombre,
                        label: (contexto) => {
                            const valor = contexto.parsed.x;
                            const porcentaje = Math.round((valor / total) * 100);
                            return ` ${money.format(valor)} · ${porcentaje}% del total`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: "#e2e8f0" },
                    ticks: {
                        callback: (valor) => money.format(valor),
                        color: "#64748b",
                        font: { size: 10 },
                    },
                },
                y: {
                    grid: { display: false },
                    ticks: { color: "#475569", font: { size: 11, weight: "600" } },
                },
            },
        },
    });
}

/* ---------------------------------------------------------------------------
   Gráfico: cumplimiento de objetivos (% de cada meta)
   --------------------------------------------------------------------------- */
const FILAS_REQUERIMIENTO = [
    { clave: "min_calorias", nutriente: "Calorias", etiqueta: "Calorías", unidad: "kcal", tipo: "minimo" },
    { clave: "min_proteinas", nutriente: "Proteinas", etiqueta: "Proteínas", unidad: "g", tipo: "minimo" },
    { clave: "min_carbohidratos", nutriente: "Carbohidratos", etiqueta: "Carbohidratos", unidad: "g", tipo: "minimo" },
    { clave: "max_grasas", nutriente: "Grasas", etiqueta: "Grasas", unidad: "g", tipo: "maximo" },
];

function renderCumplimientoChart(data) {
    const canvas = document.getElementById("cumplimientoChart");
    const wrap = document.getElementById("cumplimiento-wrap");
    const resumen = document.getElementById("cumplimiento-resumen");
    if (!canvas || !wrap) return;

    if (cumplimientoChart) {
        cumplimientoChart.destroy();
        cumplimientoChart = null;
    }

    const requerimientos = data?.requerimientos || {};
    const real = data?.resumen_nutricional || {};

    // El backend trabaja siempre a 1 día; el porcentaje no depende del plazo.
    const filas = FILAS_REQUERIMIENTO.map((fila) => {
        const objetivo = Number(requerimientos[fila.clave]) || 0;
        const valor = Number(real[fila.nutriente]) || 0;
        return {
            ...fila,
            objetivo,
            valor,
            porcentaje: objetivo > 0 ? (valor / objetivo) * 100 : 0,
        };
    }).filter((fila) => fila.objetivo > 0);

    if (filas.length === 0) {
        wrap.classList.add("hidden");
        if (resumen) {
            resumen.textContent = "El servidor no devolvió los objetivos del perfil.";
        }
        return;
    }

    wrap.classList.remove("hidden");

    const colorFila = (fila) => {
        // En un máximo (grasas) cumplir es no pasarse; en un mínimo, alcanzar.
        if (fila.tipo === "maximo") {
            return fila.porcentaje <= 100.5 ? "#059669" : "#dc2626";
        }
        return fila.porcentaje >= 99.5 ? "#059669" : "#f59e0b";
    };

    const minimo = Math.min(...filas.map((fila) => fila.porcentaje));
    if (resumen) {
        resumen.textContent =
            minimo >= 99.5
                ? "La cesta cumple todos los objetivos del perfil."
                : `El objetivo más bajo se cubre al ${Math.round(minimo)}%.`;
    }

    wrap.style.height = `${Math.max(150, filas.length * 36 + 30)}px`;

    if (typeof Chart === "undefined") {
        wrap.classList.add("hidden");
        return;
    }

    // Línea punteada en el 100 % (la meta).
    const lineaObjetivo = {
        id: "lineaObjetivo",
        afterDatasetsDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            if (!scales?.x || !chartArea) return;
            const x = scales.x.getPixelForValue(100);
            ctx.save();
            ctx.strokeStyle = "#94a3b8";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            ctx.restore();
        },
    };

    const maximo = Math.max(110, ...filas.map((fila) => fila.porcentaje));

    cumplimientoChart = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels: filas.map(
                (fila) =>
                    `${fila.etiqueta} (${fila.tipo === "maximo" ? "máx" : "mín"})`
            ),
            datasets: [
                {
                    data: filas.map((fila) => Math.round(fila.porcentaje * 10) / 10),
                    backgroundColor: filas.map(colorFila),
                    borderRadius: 6,
                    barThickness: 18,
                },
            ],
        },
        options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (contexto) => {
                            const fila = filas[contexto.dataIndex];
                            const valor = `${numberFmt(fila.valor, 2)} ${fila.unidad}`;
                            const meta = `${numberFmt(fila.objetivo, 2)} ${fila.unidad}`;
                            // Los carbohidratos tienen rango: mostramos también el tope.
                            const maxCarbs = Number(requerimientos.max_carbohidratos);
                            const extra =
                                fila.nutriente === "Carbohidratos" && maxCarbs > 0
                                    ? ` · máx ${numberFmt(maxCarbs, 2)} g`
                                    : "";
                            return ` ${valor} de ${meta} (${Math.round(
                                fila.porcentaje
                            )}%)${extra}`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    beginAtZero: true,
                    suggestedMax: maximo,
                    grid: { color: "#e2e8f0" },
                    ticks: {
                        callback: (valor) => `${valor}%`,
                        color: "#64748b",
                        font: { size: 10 },
                    },
                },
                y: {
                    grid: { display: false },
                    ticks: { color: "#475569", font: { size: 11, weight: "600" } },
                },
            },
        },
        plugins: [lineaObjetivo],
    });
}

function crearTarjeta(item, index) {
    const porciones = Number(item.porciones) || 0;
    // En alimentos.csv los macros y el costo están por 100 g y el modelo
    // trabaja con "porciones" de 100 g: gramos = porciones × 100.
    const gramos = porciones * 100;

    const card = document.createElement("article");
    card.className =
        "food-card rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-100";
    card.style.animationDelay = `${Math.min(index * 45, 270)}ms`;

    const cabecera = document.createElement("div");
    cabecera.className = "flex items-start justify-between gap-3";

    const nombre = document.createElement("h3");
    nombre.className = "text-sm font-semibold leading-snug text-slate-800";
    nombre.textContent = item.alimento;

    const subtotal = document.createElement("span");
    subtotal.className =
        "shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700";
    subtotal.textContent = money.format(Number(item.costo_subtotal) || 0);

    cabecera.append(nombre, subtotal);

    const datos = document.createElement("div");
    datos.className = "mt-3 space-y-0.5";

    // Gramos como dato principal (más intuitivo que fracciones de porción),
    // porciones como referencia de la unidad que usa el modelo.
    datos.append(
        crearDato("Cantidad", `${numberFmt(gramos)} g`, true),
        crearDato(
            "Porciones",
            `${numberFmt(porciones, 2)} ${porciones === 1 ? "porción" : "porciones"}`
        )
    );

    // Respaldo accesible del gesto de pulsación larga.
    const botonDetalle = document.createElement("button");
    botonDetalle.type = "button";
    botonDetalle.className =
        "mt-3 w-full rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500";
    botonDetalle.textContent = "Ver detalle";
    botonDetalle.addEventListener("click", () => abrirSheet(item));

    card.append(cabecera, datos, botonDetalle);

    if (window.NutriGestures) {
        NutriGestures.attach(card, {
            swipe: false,
            pinch: false,
            doubleTap: false,
        });
        card.addEventListener("nutricost:longpress", () => abrirSheet(item));
    }

    return card;
}

function crearDato(etiqueta, valor, destacado = false) {
    const caja = document.createElement("div");
    caja.className = destacado
        ? "rounded-xl bg-slate-50 px-3 py-2"
        : "flex items-baseline gap-1.5 px-3";

    const titulo = document.createElement("span");
    titulo.className = destacado
        ? "block text-[10px] uppercase tracking-wide text-slate-400"
        : "shrink-0 text-[10px] uppercase tracking-wide text-slate-400";
    titulo.textContent = etiqueta;

    const contenido = document.createElement("strong");
    contenido.className = destacado
        ? "text-xl font-bold text-slate-800"
        : "text-xs font-medium text-slate-500";
    contenido.textContent = valor;

    caja.append(titulo, contenido);
    return caja;
}

/* ===========================================================================
   Estado de UI
   =========================================================================== */
function setCargando(cargando) {
    const boton = document.getElementById("btn-calcular");
    const spinner = document.getElementById("btn-spinner");
    const texto = document.getElementById("btn-text");

    boton.disabled = cargando;
    spinner.classList.toggle("hidden", !cargando);
    texto.textContent = cargando ? "Calculando…" : "Calcular dieta óptima";
}

function mostrarAlerta(mensaje) {
    const alerta = document.getElementById("alert");
    document.getElementById("alert-text").textContent = mensaje;
    alerta.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function ocultarAlerta() {
    document.getElementById("alert").classList.add("hidden");
}

/* ===========================================================================
   Interfaz gestual
   =========================================================================== */
function initGestures() {
    if (!window.NutriGestures) {
        console.warn("Motor de gestos no disponible (gestures.js).");
        return;
    }

    // --- Swipe horizontal sobre los resultados: cambia el plazo ---
    const results = document.getElementById("results");
    if (results) {
        NutriGestures.attach(results, {
            longPress: false,
            pinch: false,
            doubleTap: false,
        });

        results.addEventListener("nutricost:swipe", (event) => {
            const { direction } = event.detail;
            if (direction !== "left" && direction !== "right") return;

            const plazos = [1, 7, 30];
            const actual = Math.max(0, plazos.indexOf(Number(state.plazo)));
            const siguiente =
                direction === "left"
                    ? (actual + 1) % plazos.length
                    : (actual - 1 + plazos.length) % plazos.length;

            const chip = document.querySelector(
                `.chip[data-group="plazo"][data-value="${plazos[siguiente]}"]`
            );
            if (!chip) return;

            seleccionarChip(chip);
            mostrarToast(
                `Plazo: ${plazos[siguiente]} ${plazos[siguiente] === 1 ? "día" : "días"}`
            );
        });
    }

    // --- Pinch sobre el gráfico: zoom de la dona ---
    const wrap = document.getElementById("macro-wrap");
    if (wrap) {
        NutriGestures.attach(wrap, {
            swipe: false,
            longPress: false,
            doubleTap: false,
        });
        wrap.addEventListener("nutricost:pinch", (event) => {
            zoomChart(event.detail.scale);
        });
    }

    // --- Doble toque en un slider: restaura su valor por defecto ---
    document.querySelectorAll('input[type="range"]').forEach((range) => {
        NutriGestures.attach(range, {
            swipe: false,
            longPress: false,
            pinch: false,
        });
        range.addEventListener("nutricost:doubletap", () => {
            range.value = range.defaultValue;
            // Reutiliza el sincronizador existente (número + relleno).
            range.dispatchEvent(new Event("input", { bubbles: true }));
            mostrarToast("Valor restaurado");
        });
    });
}

function zoomChart(factor, avisar = false) {
    chartZoom = Math.min(1.6, Math.max(0.8, chartZoom * factor));
    const canvas = document.getElementById("macroChart");
    if (canvas) {
        canvas.style.transform = `scale(${chartZoom.toFixed(3)})`;
    }
    if (avisar) {
        mostrarToast(`Zoom ${Math.round(chartZoom * 100)}%`);
    }
}

function initPaneles() {
    const hint = document.getElementById("gesture-hint");
    const cerrar = document.getElementById("gesture-hint-close");
    if (hint && cerrar) {
        cerrar.addEventListener("click", () => {
            hint.classList.add("is-hidden");
            try {
                localStorage.setItem(CLAVE_PISTA, "oculta");
            } catch (_) {
                // localStorage no disponible: la pista vuelve en la próxima visita.
            }
        });
    }

    document
        .getElementById("zoom-in")
        ?.addEventListener("click", () => zoomChart(1.15, true));
    document
        .getElementById("zoom-out")
        ?.addEventListener("click", () => zoomChart(1 / 1.15, true));
}

/* ===========================================================================
   Vistas (pestañas móvil) y opciones avanzadas
   =========================================================================== */
const VISTAS = {
    config: { tab: "tab-config", panel: "panel-config" },
    resultados: { tab: "tab-resultados", panel: "panel-resultados" },
};

function initVistas() {
    Object.entries(VISTAS).forEach(([nombre, refs]) => {
        document
            .getElementById(refs.tab)
            ?.addEventListener("click", () => mostrarVista(nombre));
    });

    document
        .getElementById("ir-config")
        ?.addEventListener("click", () => mostrarVista("config", { scroll: true }));
    document
        .getElementById("editar-perfil")
        ?.addEventListener("click", () => mostrarVista("config", { scroll: true }));

    mostrarVista("config");
}

function mostrarVista(nombre, { scroll = false } = {}) {
    Object.entries(VISTAS).forEach(([clave, refs]) => {
        const activa = clave === nombre;
        const panel = document.getElementById(refs.panel);
        const tab = document.getElementById(refs.tab);

        // En escritorio ambas columnas se ven: las clases `lg:block` del HTML
        // ganan al `hidden` porque viven dentro de una media query.
        panel?.classList.toggle("hidden", !activa);
        tab?.setAttribute("aria-selected", String(activa));
        tab?.setAttribute("tabindex", activa ? "0" : "-1");
    });

    if (nombre === "resultados") {
        // Si los gráficos se recrearon con el panel oculto (por ejemplo, al
        // cambiar el plazo desde Configurar), Chart.js pudo medir 0×0.
        window.requestAnimationFrame?.(() => {
            [macroChart, costoChart, cumplimientoChart].forEach(
                (chart) => chart?.resize?.()
            );
        });
    }

    if (scroll) {
        window.scrollTo({ top: 0, behavior: "smooth" });
    }
}

function initPistaGestos() {
    const hint = document.getElementById("gesture-hint");
    if (!hint) return;
    try {
        if (localStorage.getItem(CLAVE_PISTA) === "oculta") {
            hint.classList.add("is-hidden");
        }
    } catch (_) {
        // Sin localStorage se mantiene la pista visible.
    }
}

function actualizarResumenAvanzadas() {
    const resumen = document.getElementById("avanzadas-resumen");
    if (!resumen) return;

    const partes = [];
    if (state.tasa > 0) partes.push(`Tasa ${numeroBs.format(state.tasa)}`);
    if (state.obligatorios.size > 0) {
        partes.push(
            `${state.obligatorios.size} obligatorio${
                state.obligatorios.size === 1 ? "" : "s"
            }`
        );
    }
    if (state.excluidos.size > 0) {
        partes.push(
            `${state.excluidos.size} excluido${
                state.excluidos.size === 1 ? "" : "s"
            }`
        );
    }

    resumen.textContent = partes.length > 0 ? partes.join(" · ") : "Tasa y filtros";
}

/* ===========================================================================
   Hoja de detalle (pulsación larga / botón "Ver detalle")
   =========================================================================== */
function initSheet() {
    const backdrop = document.getElementById("sheet-backdrop");
    const sheet = document.getElementById("sheet");
    const cerrar = document.getElementById("sheet-close");
    if (!backdrop || !sheet || !cerrar) return;

    backdrop.addEventListener("click", cerrarSheet);
    cerrar.addEventListener("click", cerrarSheet);

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") cerrarSheet();
    });

    if (window.NutriGestures) {
        NutriGestures.attach(sheet, {
            swipeDistance: 45,
            longPress: false,
            pinch: false,
            doubleTap: false,
        });
        sheet.addEventListener("nutricost:swipe", (event) => {
            if (event.detail.direction === "down") cerrarSheet();
        });
    }
}

function abrirSheet(item) {
    const sheet = document.getElementById("sheet");
    const backdrop = document.getElementById("sheet-backdrop");
    const titulo = document.getElementById("sheet-title");
    const body = document.getElementById("sheet-body");
    if (!sheet || !backdrop || !titulo || !body) return;

    const porciones = Number(item.porciones) || 0;
    const gramos = porciones * 100;
    const escalar = (valor) => (Number(valor) || 0) * porciones;

    titulo.textContent = item.alimento;
    body.replaceChildren();

    body.append(
        crearDato("Cantidad", `${numberFmt(gramos)} g`, true),
        crearDato(
            "Porciones",
            `${numberFmt(porciones, 2)} ${porciones === 1 ? "porción" : "porciones"}`
        ),
        crearDato("Costo subtotal", money.format(Number(item.costo_subtotal) || 0)),
        crearDato("Calorías (total)", `${numberFmt(escalar(item.calorias))} kcal`),
        crearDato("Proteínas (total)", `${numberFmt(escalar(item.proteinas), 1)} g`),
        crearDato(
            "Carbohidratos (total)",
            `${numberFmt(escalar(item.carbohidratos), 1)} g`
        ),
        crearDato("Grasas (total)", `${numberFmt(escalar(item.grasas), 1)} g`)
    );

    backdrop.classList.remove("hidden");
    sheet.classList.remove("hidden");
    document.body.classList.add("overflow-hidden");

    // Fuerza un reflow para que el navegador registre el estado inicial y
    // la transición de translateY se ejecute (más fiable que rAF, que puede
    // estrangularse en pestañas de fondo o en modo headless).
    void sheet.offsetHeight;
    sheet.classList.add("is-open");

    document.getElementById("sheet-close")?.focus();
}

function cerrarSheet() {
    const sheet = document.getElementById("sheet");
    const backdrop = document.getElementById("sheet-backdrop");
    if (!sheet || sheet.classList.contains("hidden")) return;

    sheet.classList.remove("is-open");
    document.body.classList.remove("overflow-hidden");

    window.setTimeout(() => {
        sheet.classList.add("hidden");
        backdrop?.classList.add("hidden");
    }, 250);
}

/* ===========================================================================
   Toast de confirmación de gestos
   =========================================================================== */
function mostrarToast(mensaje) {
    const toast = document.getElementById("toast");
    if (!toast) return;

    toast.textContent = mensaje;
    toast.classList.add("is-visible");

    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(
        () => toast.classList.remove("is-visible"),
        1600
    );
}
