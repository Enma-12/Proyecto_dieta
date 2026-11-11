// NutriCost - frontend de la API Flask
let nutrientesChart = null;
let costosChart = null;

const API_URL = "http://127.0.0.1:5000/optimizar";
const MONEDA = "USD"; // Cambia a VES si tus precios están en bolívares.
const GRAMOS_POR_PORCION = 100; // Una porción del backend equivale a 100 g.

const form = document.getElementById("diet-form");
const button = document.getElementById("btn-optimizar");
const errorBox = document.getElementById("form-error");

const money = (value) => new Intl.NumberFormat("es-VE", {
    style: "currency",
    currency: MONEDA,
    minimumFractionDigits: 2
}).format(Number(value) || 0);

const number = (value, decimals = 1) => new Intl.NumberFormat("es-VE", {
    maximumFractionDigits: decimals
}).format(Number(value) || 0);

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.textContent = "";

    const datos = {
        min_calorias: Number(document.getElementById("min_calorias").value),
        min_proteinas: Number(document.getElementById("min_proteinas").value),
        min_carbohidratos: Number(document.getElementById("min_carbohidratos").value),
        max_carbohidratos: Number(document.getElementById("max_carbohidratos").value),
        max_grasas: Number(document.getElementById("max_grasas").value),
        max_porciones_por_alimento: Number(document.getElementById("max_porciones_por_alimento").value)
    };

    if (datos.min_carbohidratos > datos.max_carbohidratos) {
        errorBox.textContent = "El mínimo de carbohidratos no puede ser mayor que el máximo.";
        return;
    }

    if (!Number.isInteger(datos.max_porciones_por_alimento) ||
        datos.max_porciones_por_alimento < 1) {
        errorBox.textContent = "El máximo de porciones debe ser un número entero mayor que cero.";
        return;
    }

    button.disabled = true;
    button.querySelector(".button-text").textContent = "Calculando menú...";
    button.querySelector(".button-arrow").textContent = "…";

    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(datos)
        });

        const resultado = await response.json();

        if (!response.ok) {
            throw new Error(resultado.error || "No se pudo calcular el menú.");
        }

        mostrarResultados(resultado, datos);
    } catch (error) {
        console.error("Error al optimizar:", error);
        errorBox.textContent = error.message.includes("Failed to fetch")
            ? "No se pudo conectar con Flask. Comprueba que app.py esté ejecutándose en el puerto 5000."
            : error.message;
    } finally {
        button.disabled = false;
        button.querySelector(".button-text").textContent = "Calcular menú óptimo";
        button.querySelector(".button-arrow").textContent = "→";
    }
});

function mostrarResultados(data, metas) {
    if (!data || data.estado !== "Optimal" || !Array.isArray(data.alimentos)) {
        throw new Error("La respuesta del servidor no tiene el formato esperado.");
    }

    document.getElementById("welcome").classList.add("hidden");
    document.getElementById("results").classList.remove("hidden");

    document.getElementById("costo-total").textContent = money(data.costo_total);
    document.getElementById("cantidad-alimentos").textContent =
        number(data.alimentos.length, 0);

    const pesoTotal = data.alimentos.reduce(
        (total, item) => total + Number(item.porciones || 0) * GRAMOS_POR_PORCION,
        0
    );
    document.getElementById("peso-total").textContent = `${number(pesoTotal, 0)} g`;

    renderizarTabla(data.alimentos);
    renderizarResumenNutricional(data.resumen_nutricional, metas);
    renderizarGraficoNutrientes(data.resumen_nutricional, metas);
    renderizarGraficoCostos(data.alimentos);
}

function renderizarTabla(alimentos) {
    const tbody = document.querySelector("#tabla-resultados tbody");
    tbody.replaceChildren();

    alimentos.forEach((item) => {
        const tr = document.createElement("tr");
        const valores = [
            item.alimento,
            `${Number(item.porciones)} × ${GRAMOS_POR_PORCION} g`,
            `${number(Number(item.porciones || 0) * GRAMOS_POR_PORCION, 0)} g`,
            money(item.costo_subtotal)
        ];

        valores.forEach((valor) => {
            const td = document.createElement("td");
            td.textContent = valor;
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

function obtenerMetricas(nutrientes, metas) {
    const calorias = Number(nutrientes.Calorias || 0);
    const proteinas = Number(nutrientes.Proteinas || 0);
    const carbos = Number(nutrientes.Carbohidratos || 0);
    const grasas = Number(nutrientes.Grasas || 0);

    return [
        {
            nombre: "Calorías",
            valor: calorias,
            unidad: "kcal",
            referencia: metas.min_calorias,
            porcentaje: metas.min_calorias > 0 ? calorias / metas.min_calorias * 100 : 0,
            cumple: calorias >= metas.min_calorias,
            regla: `Mínimo ${number(metas.min_calorias)} kcal`,
            tipo: "mínimo"
        },
        {
            nombre: "Proteínas",
            valor: proteinas,
            unidad: "g",
            referencia: metas.min_proteinas,
            porcentaje: metas.min_proteinas > 0 ? proteinas / metas.min_proteinas * 100 : 0,
            cumple: proteinas >= metas.min_proteinas,
            regla: `Mínimo ${number(metas.min_proteinas)} g`,
            tipo: "mínimo"
        },
        {
            nombre: "Carbohidratos",
            valor: carbos,
            unidad: "g",
            referencia: metas.max_carbohidratos,
            porcentaje: metas.max_carbohidratos > 0 ? carbos / metas.max_carbohidratos * 100 : 0,
            cumple: carbos >= metas.min_carbohidratos && carbos <= metas.max_carbohidratos,
            regla: `${number(metas.min_carbohidratos)}–${number(metas.max_carbohidratos)} g`,
            tipo: "rango"
        },
        {
            nombre: "Grasas",
            valor: grasas,
            unidad: "g",
            referencia: metas.max_grasas,
            porcentaje: metas.max_grasas > 0 ? grasas / metas.max_grasas * 100 : 0,
            cumple: grasas <= metas.max_grasas,
            regla: `Máximo ${number(metas.max_grasas)} g`,
            tipo: "máximo"
        }
    ];
}

function renderizarResumenNutricional(nutrientes, metas) {
    const contenedor = document.getElementById("nutrition-summary");
    contenedor.replaceChildren();

    obtenerMetricas(nutrientes, metas).forEach((m) => {
        const item = document.createElement("div");
        item.className = "nutrient-item";

        const nombre = document.createElement("span");
        nombre.className = "nutrient-name";
        nombre.textContent = m.nombre;

        const valor = document.createElement("strong");
        valor.className = "nutrient-value";
        valor.textContent = `${number(m.valor)} ${m.unidad}`;

        const objetivo = document.createElement("span");
        objetivo.className = "nutrient-target";
        objetivo.textContent = m.regla;

        const estado = document.createElement("span");
        estado.className = `nutrient-state ${m.cumple ? "" : "warning"}`;
        estado.textContent = m.cumple ? "✓ Dentro del objetivo" : "⚠ Fuera del objetivo";

        item.append(nombre, valor, objetivo, estado);
        contenedor.appendChild(item);
    });
}

function renderizarGraficoNutrientes(nutrientes, metas) {
    const canvas = document.getElementById("chartNutrientes");
    if (nutrientesChart) nutrientesChart.destroy();

    const metricas = obtenerMetricas(nutrientes, metas);
    const colores = metricas.map(m => m.cumple ? "#20a675" : "#ed9b42");

    nutrientesChart = new Chart(canvas, {
        type: "bar",
        data: {
            labels: metricas.map(m => m.nombre),
            datasets: [{
                label: "Porcentaje del objetivo",
                data: metricas.map(m => Number(m.porcentaje.toFixed(1))),
                backgroundColor: colores,
                borderRadius: 7,
                borderSkipped: false,
                barThickness: 22
            }]
        },
        options: {
            indexAxis: "y",
            maintainAspectRatio: false,
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const m = metricas[context.dataIndex];
                            return ` ${number(m.porcentaje)}% · ${number(m.valor)} ${m.unidad} (${m.regla})`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    suggestedMax: 120,
                    grid: { color: "#edf1f4" },
                    ticks: { callback: value => `${value}%`, color: "#8792a2", font: { size: 10 } }
                },
                y: {
                    grid: { display: false },
                    ticks: { color: "#536174", font: { size: 11, weight: "600" } }
                }
            }
        }
    });
}

function renderizarGraficoCostos(alimentos) {
    const canvas = document.getElementById("chartCostos");
    if (costosChart) costosChart.destroy();

    costosChart = new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: alimentos.map(item => item.alimento),
            datasets: [{
                data: alimentos.map(item => Number(item.costo_subtotal)),
                backgroundColor: [
                    "#20a675", "#3984d6", "#edaa45", "#8066c7",
                    "#e47765", "#43aeb0", "#718096", "#b1c66b"
                ],
                borderColor: "#ffffff",
                borderWidth: 3,
                hoverOffset: 7
            }]
        },
        options: {
            maintainAspectRatio: false,
            responsive: true,
            cutout: "66%",
            plugins: {
                legend: {
                    position: "bottom",
                    labels: {
                        usePointStyle: true,
                        pointStyle: "circle",
                        padding: 13,
                        color: "#687588",
                        font: { size: 10 }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const porcentaje = total ? context.raw / total * 100 : 0;
                            return ` ${money(context.raw)} · ${number(porcentaje)}%`;
                        }
                    }
                }
            }
        }
    });
}
