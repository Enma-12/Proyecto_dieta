# 🥗 NutriCost · Sistema de Optimización de Costos de Menús

Proyecto para la asignatura de **Investigación de Operaciones**. Calcula la combinación
exacta de alimentos que cumple los requerimientos nutricionales de una persona al
**menor costo económico posible**, con una interfaz móvil de tipo gestual y una capa
de explicabilidad del motor de decisión.

---

## 📌 Características

- **Motor de decisión MILP:** Programación Lineal Entera Mixta resuelta con `PuLP` + CBC.
- **Perfil antropométrico:** TMB (Mifflin-St Jeor), TDEE, ajuste por objetivo y reparto de macros.
- **Restricciones reales:** mínimos de calorías/proteínas/carbohidratos, techos de carbohidratos y grasas, máximo de porciones por alimento, presupuesto y listas de alimentos obligatorios/excluidos.
- **Presupuesto por periodo:** el monto ingresado es el total del plazo elegido (1, 7 o 30 días); el frontend envía al backend el equivalente diario (`presupuesto / plazo`) y multiplica el resultado por el plazo. El tope del presupuesto crece con el plazo ($100 / $200 / $600) para que los perfiles de muchas calorías sigan siendo alcanzables.
- **Tasa BCV USD → VES:** campo editable con los bolívares por dólar y equivalente en bolívares del costo total, actualizado al instante sin repetir la consulta. La tasa se guarda en `localStorage`.
- **Cantidades en gramos:** cada tarjeta muestra los gramos como dato principal (`porciones × 100 g`) y las porciones como referencia.
- **Interfaz gestual:** swipe, pulsación larga, pinch y doble toque con Pointer Events (sin librerías externas) y respaldo accesible por botones.
- **Explicabilidad:** precios sombra (duales) disponibles en la API y diagnóstico específico cuando los alimentos obligatorios agotan un tope.
- **API REST:** backend Flask + frontend separado con CORS.
- **Modo consola:** `modelo.py` resuelve el mismo modelo sin servidor.

---

## 🛠️ Stack tecnológico

| Capa | Tecnología |
|---|---|
| Backend | Python 3, Flask, Flask-CORS, PuLP (CBC), Pandas |
| Frontend | HTML5, CSS3, JavaScript (Fetch API, Pointer Events), Tailwind CSS (CDN), Chart.js (CDN) |
| Optimización | MILP: branch-and-bound sobre relajación lineal |

---

## 📂 Estructura del proyecto

```
Proyecto_dieta/
├── app.py               # API Flask + modelo MILP + sensibilidad
├── modelo.py            # Versión consola del mismo modelo
├── alimentos.csv        # Dataset: costo y macros por 100 g de cada alimento
├── Frontend/
│   ├── index.html       # Interfaz (pestañas, hoja de detalle, gráficos)
│   ├── style.css        # Ergonomía táctil, hoja inferior y barras
│   ├── gestures.js      # Reconocedor de gestos (swipe, long-press, pinch, doble tap)
│   └── script.js        # Estado, llamadas a la API y render
└── README.md
```

---

## 🚀 Instalación y uso (local)

1. Clona el repositorio:

   ```bash
   git clone <URL_DEL_REPOSITORIO>
   cd Proyecto_dieta
   ```

2. Instala dependencias:

   ```bash
   pip install flask flask-cors pandas "pulp<4"
   ```

3. Arranca la API:

   ```bash
   python app.py
   ```

   Queda escuchando en `http://0.0.0.0:5000`.

4. Abre `Frontend/index.html` en el navegador (o sírvelo con Live Server).
   La API debe estar en `http://127.0.0.1:5000` (ver `API_BASE` en `script.js`).

### Modo consola

```bash
python modelo.py
python modelo.py --min-calorias 2200 --max-porciones 2
python modelo.py --sensibilidad
python modelo.py --presupuesto 2.0 --obligatorio "Maní" --excluir "Lentejas (secas)"
```

---

## 👆 Interfaz gestual

La interfaz reconoce gestos con **Pointer Events**, por lo que funciona con dedo,
ratón o lápiz. Cada gesto tiene un control equivalente para accesibilidad y teclado.

| Gesto | Zona | Acción | Respaldo accesible |
|---|---|---|---|
| **Swipe ← / →** | Panel de resultados | Cambia el plazo: 1 → 7 → 30 días | Chips “Plazo” |
| **Pulsación larga** (450 ms) | Tarjeta de alimento | Abre la hoja con los macros totales del alimento | Botón “Ver detalle” |
| **Pinch** | Gráfico de macros | Zoom de la dona (80 % – 160 %) | Botones **− / +** |
| **Doble toque** | Cualquier deslizador | Restaura el valor por defecto | Escribir el valor |
| **Swipe ↓** | Hoja de detalle | Cierra la hoja | Botón “Cerrar” / tocar fuera / `Esc` |

Detalles de implementación:

- `touch-action: pan-y` en las zonas con gestos horizontales: el scroll vertical sigue funcionando y el navegador no se queda el swipe ni el pinch.
- La pulsación larga cancela el menú contextual y la selección de texto en táctil.
- Se respeta `prefers-reduced-motion`; las animaciones se desactivan si el usuario lo pide.

---

## 🖥️ Diseño y gráficos

La interfaz se adapta en dos niveles:

- **Móvil:** pestañas **Configurar / Resultados**. Al calcular, la app cambia
  automáticamente a Resultados; el botón **Editar** (o la pestaña Configurar)
  devuelve al formulario. La tasa BCV y los filtros de alimentos viven en
  **Opciones avanzadas**, cerradas por defecto, para acortar el formulario.
- **Escritorio (≥1024 px):** dos columnas; el formulario a la izquierda y los
  resultados a la derecha, sin bajar para comparar ambos.

Los resultados incluyen tres visualizaciones:

| Gráfico | Tipo | Qué responde |
|---|---|---|
| **¿En qué se va el dinero?** | Barras horizontales | Costo y porcentaje de cada alimento de la cesta. |
| **Distribución de calorías** | Dona | Reparto de kcal entre proteínas, carbohidratos y grasas. |
| **Cumplimiento de objetivos** | Barras + línea punteada en el 100 % | Porcentaje cubierto de cada meta (kcal, proteínas, carbohidratos y grasas). |

- Todos usan Chart.js y se recrean al cambiar el plazo.
- Si el CDN de Chart.js no carga, el resto de la app sigue funcionando; los
  gráficos se omiten y se conservan sus resúmenes textuales.
- El gráfico de cumplimiento usa el campo `requerimientos` de la respuesta; si el
  backend no lo envía, muestra un aviso en lugar de un gráfico vacío.
- Los precios sombra siguen disponibles en la API (`sensibilidad` y
  `POST /sensibilidad`), pero ya no se muestran como tarjeta en la interfaz.

---

## 💱 Tasa BCV (USD → VES)

La app calcula y envía todo en **dólares**; la conversión a bolívares es solo de
presentación.

- En **Tus reglas → Opciones avanzadas** hay un campo **Tasa BCV (Bs. por 1 USD)**
  donde el usuario escribe cuántos bolívares equivalen a un dólar.
- El valor inicial es de referencia (`36,00`) y se edita libremente.
- La tasa se persiste en `localStorage` (`nutricost.tasa`), por lo que se conserva
  al recargar. Si existe la clave antigua `nutricost.tasas`, se migra la tasa BCV.
  En modo privado la app sigue funcionando con el valor por defecto.
- El resumen muestra el costo en USD, el equivalente `Bs. X.XXX,XX` y la tasa
  aplicada (`Tasa BCV: 36,00 Bs./USD`).
- El equivalente se recalcula al instante al cambiar la tasa, el plazo o el
  resultado, **sin volver a llamar a la API**.
- Si la tasa queda vacía o en cero, el equivalente se muestra como `—`.

Fórmula:

```
Monto en bolívares (VES) = Costo total en USD × Tasa BCV (Bs./USD)
```

---

## 🧮 Modelo matemático

Variables de decisión (porciones del alimento *i*):

```
x_i ∈ ℤ,   0 ≤ x_i ≤ M
```

> En `alimentos.csv` cada fila son **100 g** del alimento: los macros y el costo
> están expresados por 100 g. Por eso el frontend muestra `gramos = porciones × 100`.

Función objetivo (minimizar el costo total):

```
min  Σ Costo_i · x_i
```

Restricciones:

```
Σ Calorías_i       · x_i ≥ min_calorías
Σ Proteínas_i      · x_i ≥ min_proteínas
Σ Carbohidratos_i  · x_i ≥ min_carbohidratos
Σ Carbohidratos_i  · x_i ≤ max_carbohidratos
Σ Grasas_i         · x_i ≤ max_grasas
```

Restricciones opcionales:

```
Σ Costo_i · x_i ≤ presupuesto_maximo
x_i ≥ 1   para cada alimento obligatorio
x_i = 0   para cada alimento excluido
```

> El backend optimiza siempre para **1 día**. El frontend divide el presupuesto del
> periodo entre el plazo (`presupuesto_maximo = presupuesto_total / plazo`) y luego
> multiplica costo, macros y porciones por el plazo para mostrarlos.

---

## 🧠 Técnica / motor explicado

### 1. ¿Por qué es MILP y no LP?

Las restricciones son lineales, pero las variables son **enteras**: no se compran
2.37 porciones. Un MILP se resuelve con **branch-and-bound**:

1. Se resuelve la relajación lineal (`x_i` reales) → cota inferior del costo.
2. Si la solución tiene fracciones, se ramifica (`x_i ≤ ⌊x_i⌋` y `x_i ≥ ⌈x_i⌉`).
3. Se poda toda rama cuya cota ya supere la mejor solución entera encontrada.

El óptimo entero es siempre **mayor o igual** al continuo; la diferencia es el
**costo de la integralidad**, reportado por el sistema.

### 2. Cota superior `M`

`x_i ≤ M` es una cota de caja declarada en la variable (`upBound`), no como
restricción. Aporta:

- **Realismo:** evita dietas absurdas tipo “10 porciones del mismo alimento al día”.
- **Eficiencia:** reduce el espacio de búsqueda.
- **Acotación:** al minimizar, el problema no puede ser no acotado.

### 3. Precios sombra (explicabilidad)

Sobre la relajación lineal se extraen los **duales** de cada restricción:

- Restricción de **mínimo** (`≥`): π ≥ 0. Costo marginal de exigir una unidad más.
- Restricción de **máximo** (`≤`): π ≤ 0. Ahorro marginal de relajar el techo.

Responden preguntas como *“¿qué nutriente me está encareciendo la dieta?”*. Se
exponen en el campo `sensibilidad` de la respuesta y en `POST /sensibilidad`; la
interfaz ya no los muestra como tarjeta.

> CBC solo reporta duales en problemas continuos; por eso el backend reconstruye
> el modelo con `cat="Continuous"` y lo resuelve aparte (milisegundos con este dataset).

### 4. Infactibilidad

Si las restricciones se contradicen (por ejemplo, `min_carbohidratos >
max_carbohidratos`, o un `M` demasiado pequeño para alcanzar las calorías), el
politopo factible es vacío y el solver devuelve `Infeasible`. **No es un error del
programa:** es un resultado matemático válido que la API reporta como HTTP `422`.

Lo mismo ocurre si el presupuesto diario es demasiado bajo para cubrir los mínimos
nutricionales: el modelo resulta infactible y la API responde `422`. En ese caso
conviene subir el presupuesto o reducir el plazo.

### 5. ¿Esto es inteligencia artificial?

Sí, en el sentido clásico: la optimización y la búsqueda son ramas fundacionales de
la IA. El sistema es **determinista y explicable**, no un modelo de *machine
learning* entrenado con datos. No hay caja negra: cada decisión se puede justificar
con la formulación y los precios sombra.

---

## 🔌 API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/alimentos` | Lista de alimentos disponibles |
| `POST` | `/optimizar` | Resuelve el MILP con parámetros nutricionales directos |
| `POST` | `/optimizar_perfil` | Calcula macros desde el perfil y resuelve el MILP |
| `POST` | `/sensibilidad` | Solo costo relajado + precios sombra |

### Ejemplo: perfil

```bash
curl -X POST http://127.0.0.1:5000/optimizar_perfil \
  -H "Content-Type: application/json" \
  -d '{
    "peso": 70, "altura": 175, "edad": 25,
    "genero": "hombre", "actividad": 1.55, "objetivo": "mantener",
    "presupuesto_maximo": 5,
    "alimentos_obligatorios": [],
    "alimentos_excluidos": ["Hígado de res"]
  }'
```

Respuesta (resumida):

```json
{
  "estado": "Optimal",
  "costo_total": 1.68,
  "alimentos": [
    {
      "alimento": "Huevos enteros",
      "porciones": 1,
      "costo_unitario": 0.28,
      "costo_subtotal": 0.28,
      "calorias": 155.0,
      "proteinas": 13.0,
      "carbohidratos": 1.1,
      "grasas": 11.0
    }
  ],
  "resumen_nutricional": {
    "Calorias": 2502.0,
    "Proteinas": 135.0,
    "Carbohidratos": 343.1,
    "Grasas": 68.5
  },
  "requerimientos": {
    "min_calorias": 2594.31,
    "min_proteinas": 140.0,
    "min_carbohidratos": 346.43,
    "max_carbohidratos": 396.43,
    "max_grasas": 72.06
  },
  "sensibilidad": {
    "costo_relajado": 1.24,
    "costo_integralidad": 0.44,
    "precios_sombra": [
      {
        "restriccion": "Minimo_Proteinas",
        "nutriente": "Proteinas",
        "tipo": "minimo",
        "unidad": "g",
        "por_unidad": 0.005729,
        "por_100_unidades": 0.5729,
        "activa": true
      }
    ]
  }
}
```

`requerimientos` contiene los límites que usó el modelo (`min_calorias`,
`min_proteinas`, `min_carbohidratos`, `max_carbohidratos`, `max_grasas`) y permite
al frontend dibujar el gráfico de **cumplimiento de objetivos** comparándolos con
`resumen_nutricional`.

### Códigos de respuesta

| Código | Significado |
|---|---|
| `200` | Solución óptima |
| `400` | Datos faltantes o inválidos |
| `422` | Requerimientos o presupuesto imposibles (ver `codigo` abajo) |
| `500` | Fallo interno del solver |

Los `422` incluyen un campo `codigo` para que el frontend distinga el motivo:

| `codigo` | Significado |
|---|---|
| `presupuesto_insuficiente` | El presupuesto no alcanza para los requerimientos del perfil. |
| `requerimientos_imposibles` | Los requerimientos chocan con los topes del modelo (carbohidratos, grasas o alimentos obligatorios). |

Cuando el motivo es el presupuesto, la respuesta incluye además
`costo_minimo_diario`: el costo mínimo que necesita el perfil sin la cota de gasto.
El frontend lo multiplica por el plazo y muestra, por ejemplo:

> “Necesitas al menos $4.86/día ($146.00 para 30 días). Prueba aumentando el
> presupuesto o reduciendo el plazo.”

El backend detecta el caso de presupuesto reintentando el modelo **sin** la cota de
gasto: si así encuentra óptimo, la infeasibilidad venía del presupuesto. La
restricción usa una tolerancia numérica (`1e-6`) para no rechazar un presupuesto que
coincide exactamente con el costo mínimo.

### Diagnóstico de alimentos obligatorios

Cada alimento obligatorio impone `x_i >= 1`, es decir, al menos 100 g. Esa suma es
un piso inevitable: si por sí sola supera el tope de grasas, el de carbohidratos o
el presupuesto, **ninguna** combinación del resto puede arreglarlo. En ese caso el
`422` por `requerimientos_imposibles` incluye:

```json
{
  "codigo": "requerimientos_imposibles",
  "mensaje": "Con 10 alimentos obligatorios no hay solución: una porción de cada uno ya aporta 88 g de grasas y el máximo es 72 g; ... Quita alguno de la lista de obligatorios y vuelve a calcular.",
  "diagnostico": {
    "alimentos": 10,
    "aportes": { "costo": 6.09, "calorias": 1674.0, "proteinas": 200.0,
                 "carbohidratos": 10.8, "grasas": 88.0 },
    "violaciones": [
      {
        "restriccion": "Maximo_Grasas",
        "nutriente": "Grasas",
        "unidad": "g",
        "aporte": 88.0,
        "limite": 72.06,
        "exceso": 15.94,
        "sugerencias": [
          { "alimento": "Queso blanco duro", "aporte": 25.0 }
        ]
      }
    ]
  }
}
```

- `aportes` es el mínimo que aporta una porción de cada obligatorio.
- `violaciones` lista solo los topes que ese mínimo ya supera.
- `sugerencias` ordena los obligatorios que más aportan al nutriente violado,
  para que el usuario sepa cuáles quitar primero.

En la interfaz, al superar **5 alimentos obligatorios** aparece un aviso (no un
bloqueo) explicando que el cálculo podría quedar sin solución. Es una advertencia
blanda: el modelo puede seguir siendo factible, y solo se confirma al calcular.

---

## ⚠️ Limitaciones y trabajo futuro

- El dataset usa precios de referencia; no está conectado a un mercado real.
- Las porciones son enteras y cada una equivale a 100 g de `alimentos.csv`; no hay
  pesos de porción propios por alimento (p. ej. “1 huevo”).
- La tasa BCV es manual: no se consulta en línea, la actualiza el usuario.
- El análisis de sensibilidad usa la relajación lineal: es una aproximación local del
  efecto marginal, no una predicción exacta del MILP.
- Trabajo futuro: tasas en vivo vía API, recomendador de alimentos similares (KNN),
  precios dinámicos y perfiles de usuario persistidos.
