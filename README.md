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
- **Interfaz gestual:** swipe, pulsación larga, pinch y doble toque con Pointer Events (sin librerías externas) y respaldo accesible por botones.
- **Explicabilidad:** precios sombra (duales) que indican qué nutriente encarece la dieta y panel “¿Cómo se calcula?”.
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
├── alimentos.csv        # Dataset: costo y macros por porción
├── Frontend/
│   ├── index.html       # Interfaz (zonas, hoja de detalle, panel del motor)
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

## 🧮 Modelo matemático

Variables de decisión (porciones del alimento *i*):

```
x_i ∈ ℤ,   0 ≤ x_i ≤ M
```

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

---

## 🧠 Técnica / motor explicado

### 1. ¿Por qué es MILP y no LP?

Las restricciones son lineales, pero las variables son **enteras**: no se compran
2.37 huevos. Un MILP se resuelve con **branch-and-bound**:

1. Se resuelve la relajación lineal (`x_i` reales) → cota inferior del costo.
2. Si la solución tiene fracciones, se ramifica (`x_i ≤ ⌊x_i⌋` y `x_i ≥ ⌈x_i⌉`).
3. Se poda toda rama cuya cota ya supere la mejor solución entera encontrada.

El óptimo entero es siempre **mayor o igual** al continuo; la diferencia es el
**costo de la integralidad**, reportado por el sistema.

### 2. Cota superior `M`

`x_i ≤ M` es una cota de caja declarada en la variable (`upBound`), no como
restricción. Aporta:

- **Realismo:** evita dietas absurdas tipo “10 huevos al día”.
- **Eficiencia:** reduce el espacio de búsqueda.
- **Acotación:** al minimizar, el problema no puede ser no acotado.

### 3. Precios sombra (explicabilidad)

Sobre la relajación lineal se extraen los **duales** de cada restricción:

- Restricción de **mínimo** (`≥`): π ≥ 0. Costo marginal de exigir una unidad más.
- Restricción de **máximo** (`≤`): π ≤ 0. Ahorro marginal de relajar el techo.

Responden preguntas como *“¿qué nutriente me está encareciendo la dieta?”* y se
muestran en la tarjeta **“¿Qué encarece tu dieta?”** del frontend.

> CBC solo reporta duales en problemas continuos; por eso el backend reconstruye
> el modelo con `cat="Continuous"` y lo resuelve aparte (milisegundos con este dataset).

### 4. Infactibilidad

Si las restricciones se contradicen (por ejemplo, `min_carbohidratos >
max_carbohidratos`, o un `M` demasiado pequeño para alcanzar las calorías), el
politopo factible es vacío y el solver devuelve `Infeasible`. **No es un error del
programa:** es un resultado matemático válido que la API reporta como HTTP `422`.

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

### Códigos de respuesta

| Código | Significado |
|---|---|
| `200` | Solución óptima |
| `400` | Datos faltantes o inválidos |
| `422` | Requerimientos matemáticamente imposibles |
| `500` | Fallo interno del solver |

---

## ⚠️ Limitaciones y trabajo futuro

- El dataset usa precios de referencia; no está conectado a un mercado real.
- Las porciones son enteras y dependen de la unidad implícita de `alimentos.csv`.
- El análisis de sensibilidad usa la relajación lineal: es una aproximación local del
  efecto marginal, no una predicción exacta del MILP.
- Trabajo futuro: recomendador de alimentos similares (KNN), precios dinámicos y
  perfiles de usuario persistidos.
