# 📋 Informe del Proyecto NutriCost

## Resumen Ejecutivo

**NutriCost** es un sistema de optimización de costos de menús que calcula la combinación exacta de alimentos que cumple los requerimientos nutricionales de una persona al **menor costo económico posible**. Desarrollado como proyecto para la asignatura de **Investigación de Operaciones**, implementa un modelo de **Programación Lineal Entera Mixta (MILP)** resuelto con PuLP + CBC, expuesto vía API REST (Flask) y consumido por una interfaz web móvil-first con gestos táctiles nativos.

El problema que resuelve es clásico: **el Problema de la Dieta (Stigler, 1945; Dantzig, 1947)** — encontrar la canasta de alimentos de costo mínimo que satisfaga restricciones nutricionales. NutriCost lo extiende con:
- Perfil antropométrico personalizado (TMB Mifflin-St Jeor, TDEE, objetivos)
- Restricciones reales (techos de carbohidratos/grasas, presupuesto, alimentos obligatorios/excluidos)
- Planificación multi-día (1, 7, 30 días) con escalado automático
- Explicabilidad mediante precios sombra (duales) y diagnóstico de infeasibilidad
- Interfaz gestual accesible sin librerías externas

---

## Funcionalidades Principales

### 1. Perfil Antropométrico → Metas Nutricionales
| Entrada | Cálculo |
|---------|---------|
| Peso, altura, edad, género | TMB (Mifflin-St Jeor) |
| Factor de actividad (1.2–1.9) | TDEE = TMB × actividad |
| Objetivo (adelgazar/mantener/músculo) | Calorías objetivo = TDEE ± 500 kcal |
| Peso | Proteínas = peso × 2.0 g |
| Calorías objetivo | Grasas máx = 25% kcal / 9 |
| Restante | Carbohidratos = (kcal - prot×4 - gras×9) / 4, con +50g holgura |

### 2. Motor de Optimización (MILP)
- **Variables**: $x_i \in \mathbb{Z}$, porciones del alimento $i$ (0 ≤ $x_i$ ≤ M, M=3 por defecto)
- **Objetivo**: Minimizar $\sum Costo_i \cdot x_i$
- **Restricciones**:
  - $\sum Calorías_i \cdot x_i \geq min\_calorías$
  - $\sum Proteínas_i \cdot x_i \geq min\_proteínas$
  - $\sum Carbohidratos_i \cdot x_i \geq min\_carbohidratos$
  - $\sum Carbohidratos_i \cdot x_i \leq max\_carbohidratos$
  - $\sum Grasas_i \cdot x_i \leq max\_grasas$
  - $\sum Costo_i \cdot x_i \leq presupuesto\_maximo$ (opcional)
  - $x_i \geq 1$ para obligatorios, $x_i = 0$ para excluidos
- **Solver**: CBC via PuLP (branch-and-bound sobre relajación lineal)

### 3. Planificación Multi-Periodo
- Usuario ingresa **presupuesto total** para 1 / 7 / 30 días
- Frontend envía al backend: $presupuesto\_maximo = presupuesto\_total / plazo$
- Backend optimiza para **1 día**; frontend multiplica costo, macros y porciones × plazo
- Topes de presupuesto escalan: {1: $100, 7: $200, 30: $600}

### 4. Tasa BCV (USD → VES)
- Campo único editable: "Bs. por 1 USD"
- Persistido en `localStorage` (`nutricost.tasa`), migra desde clave antigua `nutricost.tasas`
- Conversión instantánea sin refetch: $VES = USD \times tasa$
- Formato: `Intl.NumberFormat("es-VE", {minimumFractionDigits: 2, maximumFractionDigits: 2})` → `Bs. X.XXX,XX`

### 5. Interfaz Gestual (Pointer Events)
| Gesto | Zona | Acción |
|-------|------|--------|
| Swipe ←/→ | Resultados | Cambia plazo (1→7→30) |
| Long press (450ms) | Tarjeta alimento | Abre hoja de detalle (macros totales) |
| Pinch | Gráfico dona | Zoom 80%–160% |
| Double tap | Slider | Restaura valor por defecto |
| Swipe ↓ | Hoja detalle | Cierra hoja |

**Accesibilidad**: Cada gesto tiene respaldo por botones/teclado. Respeta `prefers-reduced-motion`.

### 6. Visualizaciones (Chart.js)
1. **¿En qué se va el dinero?** — Barras horizontales: costo y % por alimento
2. **Distribución de calorías** — Dona: kcal de proteínas (4kcal/g), carbohidratos (4kcal/g), grasas (9kcal/g)
3. **Cumplimiento de objetivos** — Barras + línea punteada 100%: % cubierto de kcal, proteínas, carbohidratos, grasas

### 7. Explicabilidad y Diagnóstico
- **Precios sombra (duales)**: Endpoint `/sensibilidad` + campo `sensibilidad` en respuestas
  - Restricción mínimo (≥): π ≥ 0 = costo marginal de +1 unidad
  - Restricción máximo (≤): π ≤ 0 = ahorro marginal de relajar techo
- **Diagnóstico de obligatorios (422 `requerimientos_imposibles`)**:
  - Calcula aportes mínimos de 1 porción de cada obligatorio
  - Identifica violaciones: grasas, carbohidratos, presupuesto
  - Sugiere qué obligatorios quitar primero (mayor aporte al nutriente violado)

### 8. Aviso Inteligente de Obligatorios
- Al seleccionar **>5 alimentos obligatorios**: banner ámbar con:
  - Lista real de seleccionados
  - Riesgos específicos: grasas, carbohidratos, proteínas, costo
  - Recomendación: "máximo 4"

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│  Frontend/index.html  (Tailwind CDN, Chart.js CDN)          │
│  Frontend/script.js   (Estado, Fetch API, Render, Gráficos) │
│  Frontend/gestures.js (Pointer Events: swipe, pinch, etc.)  │
│  Frontend/style.css   (Ergonomía táctil, animaciones)       │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP/JSON (CORS)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                         BACKEND                              │
│  app.py              Flask + PuLP/CBC + Pandas               │
│  ├── GET  /alimentos                                        │
│  ├── POST /optimizar       (parámetros directos)            │
│  ├── POST /optimizar_perfil (perfil → macros → MILP)        │
│  └── POST /sensibilidad    (relajación lineal + duales)     │
│  modelo.py           Versión consola (mismo modelo)         │
│  alimentos.csv       36 alimentos venezolanos (macros/100g) │
└─────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/alimentos` | Lista nombres de alimentos disponibles |
| `POST` | `/optimizar` | MILP con parámetros nutricionales directos |
| `POST` | `/optimizar_perfil` | Perfil → macros → MILP (usa Mifflin-St Jeor) |
| `POST` | `/sensibilidad` | Solo relajación lineal + precios sombra |

### Ejemplo: `/optimizar_perfil`
```bash
curl -X POST http://127.0.0.1:5000/optimizar_perfil \
  -H "Content-Type: application/json" \
  -d '{
    "peso": 70, "altura": 175, "edad": 25,
    "genero": "hombre", "actividad": 1.55, "objetivo": "mantener",
    "presupuesto_maximo": 5,
    "alimentos_obligatorios": ["Avena en hojuelas"],
    "alimentos_excluidos": ["Hígado de res"]
  }'
```

### Respuesta Exitosa (200)
```json
{
  "estado": "Optimal",
  "costo_total": 1.84,
  "alimentos": [
    {"alimento": "Avena en hojuelas", "porciones": 1, "costo_unitario": 0.25, ...}
  ],
  "resumen_nutricional": {"Calorias": 2502, "Proteinas": 135, "Carbohidratos": 343, "Grasas": 68},
  "requerimientos": {"min_calorias": 2594, "min_proteinas": 140, ...},
  "sensibilidad": {"costo_relajado": 1.24, "costo_integralidad": 0.44, "precios_sombra": [...]}
}
```

### Respuestas de Error (422)
```json
// Presupuesto insuficiente
{"estado": "Error", "codigo": "presupuesto_insuficiente", "mensaje": "...", "costo_minimo_diario": 1.84}

// Obligatorios violan topes
{"estado": "Error", "codigo": "requerimientos_imposibles", "mensaje": "...",
 "diagnostico": {"alimentos": 10, "aportes": {...}, "violaciones": [
   {"restriccion": "Maximo_Grasas", "nutriente": "Grasas", "aporte": 88, "limite": 72, "exceso": 16,
    "sugerencias": [{"alimento": "Queso blanco duro", "aporte": 25}]}
 ]}}
```

---

## Cómo Resuelve la Optimización de la Dieta

### Paso 1: Perfil → Metas Numéricas
```
Usuario: 70kg, 175cm, 25a, hombre, actividad 1.55, objetivo "mantener"
    │
    ▼
TMB = 10×70 + 6.25×175 - 5×25 + 5 = 1773.75 kcal
TDEE = 1773.75 × 1.55 = 2749.31 kcal
Calorías objetivo = 2749.31 + 0 = 2749.31 kcal
Proteínas mín = 70 × 2.0 = 140 g
Grasas máx = (2749.31 × 0.25) / 9 = 76.37 g
Carbohidratos mín = (2749.31 - 140×4 - 76.37×9) / 4 = 346.43 g
Carbohidratos máx = 346.43 + 50 = 396.43 g
```

### Paso 2: Construcción del MILP
- 36 variables enteras $x_i$ (0..3 porciones = 0..300g cada una)
- 5 restricciones nutricionales + presupuesto opcional + obligatorios/excluidos
- Función objetivo lineal: minimizar $\sum Costo_i x_i$

### Paso 3: Resolución Branch-and-Bound
1. **Relajación lineal** ($x_i \in \mathbb{R}$) → cota inferior del costo
2. Si hay fracciones: **ramificar** ($x_i \le \lfloor x_i \rfloor$ / $x_i \ge \lceil x_i \rceil$)
3. **Podar** ramas cuya cota supere mejor solución entera
4. **Óptimo entero** ≥ óptimo continuo (diferencia = "costo de la integralidad")

### Paso 4: Diagnóstico de Infeasibilidad
Si el solver devuelve `Infeasible`:
1. **¿Es el presupuesto?** Reintenta sin restricción de gasto
   - Si ahora es óptimo → `presupuesto_insuficiente` + `costo_minimo_diario`
2. **¿Son los obligatorios?** Calcula aportes mínimos de 1 porción cada uno
   - Compara vs topes duros (grasas, carbohidratos, presupuesto)
   - Devuelve `requerimientos_imposibles` + `diagnostico` con violaciones y sugerencias

---

## Requisitos de Instalación

### Backend (Python)
```bash
# Python 3.10+ recomendado
pip install flask flask-cors pandas "pulp<4"
# CBC viene incluido con PuLP (binarios multiplataforma)
```

### Frontend
- Navegador moderno con soporte para:
  - ES6 Modules / Fetch API
  - Pointer Events (gestos)
  - Canvas (Chart.js)
  - localStorage
- **Servir estáticos** (opciones):
  - `python -m http.server 8000 --directory Frontend` (simple)
  - Live Server (VS Code extension) — recomendado para desarrollo
  - Cualquier servidor estático (nginx, Apache, Netlify, Vercel)

### Ejecución Completa
```bash
# Terminal 1: API
cd Proyecto_dieta
python app.py
# → http://0.0.0.0:5000

# Terminal 2: Frontend
cd Proyecto_dieta/Frontend
python -m http.server 8000
# → http://localhost:8000

# En navegador: abrir http://localhost:8000
# Verificar API_BASE en script.js apunta a http://127.0.0.1:5000
```

### Modo Consola (sin servidor)
```bash
cd Proyecto_dieta
python modelo.py                                    # Defaults
python modelo.py --min-calorias 2200 --max-porciones 2
python modelo.py --sensibilidad
python modelo.py --presupuesto 2.0 --obligatorio "Maní" --excluir "Lentejas (secas)"
```

---

## Casos de Uso Típicos

| Caso | Configuración | Resultado Esperado |
|------|---------------|-------------------|
| **Perfil estándar** | 70kg, 175cm, 25a, hombre, moderado, mantener, $5/día | Cesta ~$1.84/día, 4-5 alimentos |
| **Presupuesto ajustado** | Mismo perfil, $1.50/día | 422 `presupuesto_insuficiente`, sugiere mínimo ~$1.84 |
| **Alimentos obligatorios** | + Avena, Huevos, Carne obligatorios | Incluidos en cesta si factible |
| **Muchos obligatorios** | 6+ seleccionados | Aviso ámbar: "Te recomendamos máximo 4" |
| **Obligatorios imposibles** | 10 carnes/quesos obligatorios | 422 `requerimientos_imposibles`, diagnostica grasas > límite, sugiere quitar Queso blanco duro |
| **Plan 30 días** | Plazo 30, presupuesto $150 | Optimiza diario ($5), muestra totales ×30 |
| **Cambio tasa BCV** | Editar tasa 36 → 50 | VES se recalcula instantáneo sin llamar API |

---

## Limitaciones Conocidas

1. **Dataset estático**: 36 alimentos con precios de referencia (no mercado real)
2. **Porciones fijas**: 1 porción = 100g para todos los alimentos (no "1 huevo", "1 taza")
3. **Tasa BCV manual**: No consulta API externa; usuario debe actualizar
4. **Sensibilidad local**: Precios sombra de relajación lineal, no predicción exacta MILP
5. **Sin persistencia de perfiles**: No hay base de datos ni cuentas de usuario
6. **Máx 3 porciones/alimento/día**: Hardcoded en `/optimizar_perfil` (configurable en `/optimizar`)
7. **Solo dieta diaria total**: No desglose por comida (desayuno/almuerzo/cena) — por diseño

---

## Trabajo Futuro (Roadmap)

- [ ] Tasas BCV/paralelo en vivo vía API (BCV, Monitor Dólar, etc.)
- [ ] Recomendador de sustitutos (KNN sobre macros/costo) al excluir alimentos
- [ ] Precios dinámicos por proveedor/región
- [ ] Perfiles de usuario persistidos (SQLite / localStorage + sync)
- [ ] Optimización por comida individual (desayuno/almuerzo/cena)
- [ ] Pesos de porción reales por alimento (huevo=50g, taza arroz=180g, etc.)
- [ ] Tests de integración backend + E2E (Playwright/Cypress)

---

## Licencia y Créditos

Proyecto académico - Investigación de Operaciones.
- **Motor MILP**: PuLP (MIT) + CBC (EPL/CPL)
- **Frontend**: Tailwind CSS (MIT), Chart.js (MIT), código propio
- **Datos**: Alimentos venezolanos con macros USDA/referencia

---

*Generado automáticamente como parte de la documentación del proyecto NutriCost.*