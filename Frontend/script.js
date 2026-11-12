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

const state = {
    genero: "hombre",
    objetivo: "mantener",
    actividad: 1.55,
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

const multiselects = {};

document.addEventListener("DOMContentLoaded", init);

function init() {
    bindSliders();
    bindChips();
    initMultiselect("obligatorios");
    initMultiselect("excluidos");
    document.getElementById("btn-calcular").addEventListener("click", calcularDieta);
    cargarAlimentos();
}

/* ===========================================================================
   Sliders
   =========================================================================== */
function bindSliders() {
    document.querySelectorAll('input[type="range"]').forEach((input) => {
        const render = () => actualizarSlider(input);
        input.addEventListener("input", render);
        render();
    });
}

function actualizarSlider(input) {
    const output = document.getElementById(`${input.id}-val`);
    const value = Number(input.value);

    if (output) {
        output.textContent =
            input.id === "presupuesto"
                ? money.format(value)
                : `${numberFmt(value)} ${input.dataset.unit || ""}`.trim();
    }

    const min = Number(input.min);
    const max = Number(input.max);
    const porcentaje = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty("--fill", `${porcentaje}%`);
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

    state[grupo] = grupo === "actividad" ? Number(valor) : valor;

    document.querySelectorAll(`.chip[data-group="${grupo}"]`).forEach((otro) => {
        aplicarEstadoChip(otro, otro === chip);
    });
}

function aplicarEstadoChip(chip, activo) {
    chip.setAttribute("aria-pressed", String(activo));
    chip.classList.remove(...CHIP_ACTIVE, ...CHIP_INACTIVE);
    chip.classList.add(...(activo ? CHIP_ACTIVE : CHIP_INACTIVE));
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

async function calcularDieta() {
    ocultarAlerta();

    const payload = {
        peso: Number(document.getElementById("peso").value),
        altura: Number(document.getElementById("altura").value),
        edad: Number(document.getElementById("edad").value),
        genero: state.genero,
        actividad: state.actividad,
        objetivo: state.objetivo,
        presupuesto_maximo: Number(document.getElementById("presupuesto").value),
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
            throw new Error(
                data.mensaje || data.error || `Error ${response.status} al calcular la dieta.`
            );
        }

        if (data.estado !== "Optimal" || !Array.isArray(data.alimentos)) {
            throw new Error("La respuesta del servidor no tiene el formato esperado.");
        }

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
function renderResultados(data) {
    const macro = data.resumen_nutricional || {};

    document.getElementById("res-costo").textContent = money.format(
        Number(data.costo_total) || 0
    );
    document.getElementById("res-calorias").textContent = `${numberFmt(macro.Calorias)} kcal`;
    document.getElementById("res-proteinas").textContent = `${numberFmt(macro.Proteinas)} g`;
    document.getElementById("res-carbohidratos").textContent = `${numberFmt(macro.Carbohidratos)} g`;
    document.getElementById("res-grasas").textContent = `${numberFmt(macro.Grasas)} g`;

    const contenedor = document.getElementById("cards");
    contenedor.replaceChildren();

    data.alimentos.forEach((item, index) => {
        contenedor.appendChild(crearTarjeta(item, index));
    });

    const results = document.getElementById("results");
    results.classList.remove("hidden");
    results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function crearTarjeta(item, index) {
    const porciones = Number(item.porciones) || 0;
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
    datos.className = "mt-3 grid grid-cols-2 gap-2";

    datos.append(
        crearDato("Porciones", String(porciones)),
        crearDato("Cantidad", `${numberFmt(gramos)} g`)
    );

    card.append(cabecera, datos);
    return card;
}

function crearDato(etiqueta, valor) {
    const caja = document.createElement("div");
    caja.className = "rounded-xl bg-slate-50 px-3 py-2";

    const titulo = document.createElement("span");
    titulo.className = "block text-[10px] uppercase tracking-wide text-slate-400";
    titulo.textContent = etiqueta;

    const contenido = document.createElement("strong");
    contenido.className = "text-sm text-slate-700";
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
