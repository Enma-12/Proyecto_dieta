"""
API Flask del Problema de la Dieta (MILP).

Endpoint:
    POST /optimizar
    Body JSON:
        {
            "min_calorias": 2500,
            "min_proteinas": 130,
            "min_carbohidratos": 250,
            "max_carbohidratos": 350,
            "max_grasas": 70,
            "max_porciones_por_alimento": 3
        }
    Respuesta: alimentos seleccionados (porciones enteras > 0) y costo total.

    POST /optimizar_perfil
    Body JSON:
        {
            "peso": 70,
            "altura": 175,
            "edad": 25,
            "genero": "hombre",
            "actividad": 1.55,
            "objetivo": "musculo"
        }
    Calcula TMB (Mifflin-St Jeor), TDEE, macros y devuelve el mismo JSON.

Ejecutar:
    pip install flask flask-cors
    python app.py
"""

import uuid
from pathlib import Path

import pandas as pd
import pulp
from flask import Flask, jsonify, request
from flask_cors import CORS

# ===========================================================================
# 0. FUNDAMENTO TEÓRICO (Investigación de Operaciones)
# ===========================================================================
# Este backend resuelve una variante del "Problema de la Dieta" (Stigler,
# 1945; Dantzig, 1947) como un Programa Lineal Entero Mixto (MILP):
#
#   Variables:  x_i ∈ Z,  0 <= x_i <= M        (porciones del alimento i)
#   Minimizar:  sum(Costo_i * x_i)             (función objetivo)
#   Sujeto a:
#       sum(Calorias_i * x_i)       >= min_calorias
#       sum(Proteinas_i * x_i)      >= min_proteinas
#       sum(Carbohidratos_i * x_i)  >= min_carbohidratos
#       sum(Carbohidratos_i * x_i)  <= max_carbohidratos
#       sum(Grasas_i * x_i)         <= max_grasas
#       x_i <= M                    (cota superior por alimento)
#
# 1) FUNCIÓN OBJETIVO
#    Es una combinación lineal de las variables: cada x_i se pondera por el
#    costo unitario del alimento. Minimizarla equivale a encontrar la dieta
#    más barata que cumpla los requisitos. Al ser lineal, el óptimo (en la
#    relajación) se alcanza siempre en un vértice del politopo factible.
#
# 2) ¿POR QUÉ ES MILP Y NO LP?
#    Las restricciones son lineales, pero las variables son ENTERAS: no se
#    compran 2.37 huevos. Un MILP se resuelve con branch-and-bound:
#       a) se resuelve la relajación lineal (x_i reales) -> cota inferior;
#       b) si la solución tiene fracciones, se ramifica (x_i <= floor,
#          x_i >= ceil) y se repite;
#       c) se poda toda rama cuya cota ya supere la mejor solución entera.
#    Consecuencia: el óptimo entero es siempre >= al óptimo continuo; la
#    diferencia es el "costo de la integralidad".
#
# 3) LÍMITE SUPERIOR M (upBound)
#    x_i <= M es una cota de caja. Se declara en la variable (upBound) en
#    lugar de como restricción, porque así el solver la usa directamente
#    para fijar el dominio y podar el árbol de búsqueda. Aporta:
#       - realismo: evita dietas absurdas tipo "10 huevos al día";
#       - eficiencia: reduce el espacio de búsqueda;
#       - acotación: con todas las variables acotadas, el problema no puede
#         ser no acotado (Unbounded) al minimizar.
#
# 4) DUALIDAD / SENSIBILIDAD
#    En la relajación lineal, el precio sombra (variable dual) de cada
#    restricción nutricional indica cuánto aumentaría el costo mínimo si se
#    exigiera una unidad más de ese nutriente. Sirve para responder "¿qué
#    nutriente me está encareciendo la dieta?".
#
# 5) FACTIBILIDAD
#    Si el conjunto de restricciones se contradice (p. ej. min_carbohidratos
#    > max_carbohidratos, o un M demasiado pequeño para alcanzar las
#    calorías), el politopo factible es vacío y el solver devuelve
#    "Infeasible". Eso NO es un error del programa: es un resultado
#    matemático válido que la API reporta como 422.
# ===========================================================================
# NOTA METODOLÓGICA: ESCALABILIDAD DE HORIZONTE TEMPORAL (DÍA vs. COMIDA)
# ===========================================================================
# El modelo de optimización lineal es agnóstico al periodo evaluado.
# La función objetivo (Minimizar Costo) y las restricciones nutricionales
# operan sobre el vector de parámetros recibido en la petición HTTP:
#
# 1. OPTIMIZACIÓN DIARIA TOTAL:
#    El usuario ingresa las metas globales de 24 horas
#    (Ej: 2500 kcal, 130g proteína, 250g-350g carbs, 70g grasa, M = 3 porciones).
#    El solver calcula el presupuesto global mínimo de insumos del día.
#
# 2. OPTIMIZACIÓN POR COMIDA ESPECÍFICA (Desayuno / Almuerzo / Cena):
#    El usuario desagrega sus requerimientos por plato individual
#    (Ej. Almuerzo: 800 kcal, 45g proteína, 90g-120g carbs, 25g grasa, M = 2 porciones).
#    El algoritmo resuelve la cesta óptima ajustada exclusivamente a esa comida.
# ===========================================================================


# ---------------------------------------------------------------------------
# 1. CARGA DE DATOS (una sola vez al arrancar el servidor)
# ---------------------------------------------------------------------------
RUTA_DATOS = Path(__file__).resolve().parent / "alimentos.csv"

COLUMNAS_REQUERIDAS = [
    "Alimento",
    "Costo",
    "Calorias",
    "Proteinas",
    "Carbohidratos",
    "Grasas",
]

# Parámetros nutricionales: todos numéricos y no negativos.
CAMPOS_NUTRICIONALES = (
    "min_calorias",
    "min_proteinas",
    "min_carbohidratos",
    "max_carbohidratos",
    "max_grasas",
)

# max_porciones_por_alimento se valida aparte porque debe ser entero >= 1.
CAMPOS_ENTRADA = CAMPOS_NUTRICIONALES + ("max_porciones_por_alimento",)

# Campos del endpoint /optimizar_perfil.
CAMPOS_PERFIL = ("peso", "altura", "edad", "genero", "actividad", "objetivo")

GENEROS_VALIDOS = ("hombre", "mujer")

# Ajuste calórico diario (kcal) según el objetivo del usuario.
AJUSTE_POR_OBJETIVO = {
    "adelgazar": -500,
    "mantener": 0,
    "musculo": 500,
}

NUTRIENTES = ("Calorias", "Proteinas", "Carbohidratos", "Grasas")

MENSAJE_IMPOSSIBLE = (
    "Tus requerimientos son matemáticamente imposibles de cumplir "
    "con los alimentos actuales."
)


def cargar_alimentos() -> pd.DataFrame:
    """Lee y valida alimentos.csv una única vez al arrancar."""
    df = pd.read_csv(RUTA_DATOS)
    df.columns = [columna.strip() for columna in df.columns]

    faltantes = [c for c in COLUMNAS_REQUERIDAS if c not in df.columns]
    if faltantes:
        raise ValueError(f"Faltan columnas en alimentos.csv: {faltantes}")

    df = df.dropna(how="all").reset_index(drop=True)
    if df.empty:
        raise ValueError("El archivo alimentos.csv no contiene datos.")

    return df


df = cargar_alimentos()


# ---------------------------------------------------------------------------
# 2. APLICACIÓN FLASK + CORS
# ---------------------------------------------------------------------------
app = Flask(__name__)

# CORS(app) habilita peticiones desde cualquier origen: el frontend suele
# correr en otro puerto (Vite 5173, Live Server 5500, etc.).
CORS(app)


class ModeloNoOptimo(Exception):
    """El solver no alcanzó el óptimo (Infeasible, Undefined, etc.)."""

    def __init__(self, estado: str):
        super().__init__(estado)
        self.estado = estado


# ---------------------------------------------------------------------------
# 3. VALIDACIÓN DE PARÁMETROS
# ---------------------------------------------------------------------------
def validar_parametros(payload) -> dict:
    """
    Valida el JSON de entrada y normaliza los tipos.

    Devuelve un dict con los 5 parámetros nutricionales como float y
    max_porciones_por_alimento como int, listo para **kwargs.
    """
    if not isinstance(payload, dict):
        raise ValueError("El cuerpo de la petición debe ser un objeto JSON.")

    faltantes = [campo for campo in CAMPOS_ENTRADA if campo not in payload]
    if faltantes:
        raise ValueError(f"Faltan campos obligatorios: {faltantes}")

    valores = {}

    # --- Parámetros nutricionales: numéricos y >= 0 ---
    for campo in CAMPOS_NUTRICIONALES:
        try:
            valor = float(payload[campo])
        except (TypeError, ValueError):
            raise ValueError(f"El campo '{campo}' debe ser numérico.") from None
        if valor < 0:
            raise ValueError(f"El campo '{campo}' no puede ser negativo.")
        valores[campo] = valor

    # --- max_porciones_por_alimento: entero >= 1 ---
    crudo = payload["max_porciones_por_alimento"]

    # bool es subclase de int en Python: JSON true/false no es válido aquí.
    if isinstance(crudo, bool):
        raise ValueError(
            "El campo 'max_porciones_por_alimento' debe ser un número entero."
        )
    try:
        porciones = float(crudo)
    except (TypeError, ValueError):
        raise ValueError(
            "El campo 'max_porciones_por_alimento' debe ser un número entero."
        ) from None
    if not porciones.is_integer():
        raise ValueError(
            "El campo 'max_porciones_por_alimento' debe ser un entero, "
            "no un decimal."
        )
    if porciones < 1:
        raise ValueError(
            "El campo 'max_porciones_por_alimento' debe ser al menos 1."
        )
    valores["max_porciones_por_alimento"] = int(porciones)

    return valores


def leer_parametros_opcionales(payload) -> dict:
    """
    Lee y valida los campos opcionales del body:
        presupuesto_maximo, alimentos_obligatorios, alimentos_excluidos.
    Devuelve solo las claves presentes para poder hacer **kwargs.
    """
    if not isinstance(payload, dict):
        return {}

    opcionales = {}

    # presupuesto_maximo: numérico y >= 0
    if payload.get("presupuesto_maximo") is not None:
        try:
            presupuesto = float(payload["presupuesto_maximo"])
        except (TypeError, ValueError):
            raise ValueError("El campo 'presupuesto_maximo' debe ser numérico.") from None
        if presupuesto < 0:
            raise ValueError("El campo 'presupuesto_maximo' no puede ser negativo.")
        opcionales["presupuesto_maximo"] = presupuesto

    # listas de nombres de alimentos
    for campo in ("alimentos_obligatorios", "alimentos_excluidos"):
        if payload.get(campo) is None:
            continue
        lista = payload[campo]
        if not isinstance(lista, list):
            raise ValueError(f"El campo '{campo}' debe ser una lista de nombres.")
        nombres = []
        for nombre in lista:
            if not isinstance(nombre, str) or not nombre.strip():
                raise ValueError(
                    f"El campo '{campo}' solo admite nombres de alimentos no vacíos."
                )
            nombres.append(nombre.strip())
        opcionales[campo] = nombres

    return opcionales


# ---------------------------------------------------------------------------
# 3-bis. PERFIL ANTROPOMÉTRICO -> PARÁMETROS DEL MODELO
# ---------------------------------------------------------------------------
def calcular_parametros_desde_perfil(payload) -> dict:
    """
    Traduce un perfil (peso, altura, edad, género, actividad, objetivo) en
    los 6 parámetros que consume resolver_dieta().

    Fórmulas:
      TMB (Mifflin-St Jeor):
          hombre: 10*peso + 6.25*altura - 5*edad + 5
          mujer : 10*peso + 6.25*altura - 5*edad - 161
      TDEE = TMB * actividad
      min_calorias = TDEE + ajuste(objetivo)   [-500 / 0 / +500]
      min_proteinas = peso * 2.0 g
      max_grasas = (min_calorias * 0.25) / 9 g  (25% de las kcal en grasa)
      calorias_restantes = min_calorias - proteinas*4 - grasas*9
      min_carbohidratos = calorias_restantes / 4 g
      max_carbohidratos = min_carbohidratos + 50 g (holgura)
      max_porciones_por_alimento = 3
    """
    if not isinstance(payload, dict):
        raise ValueError("El cuerpo de la petición debe ser un objeto JSON.")

    faltantes = [campo for campo in CAMPOS_PERFIL if campo not in payload]
    if faltantes:
        raise ValueError(f"Faltan campos obligatorios: {faltantes}")

    # --- Campos numéricos: peso, altura, edad y factor de actividad ---
    numeros = {}
    for campo in ("peso", "altura", "edad", "actividad"):
        try:
            valor = float(payload[campo])
        except (TypeError, ValueError):
            raise ValueError(f"El campo '{campo}' debe ser numérico.") from None
        if valor <= 0:
            raise ValueError(f"El campo '{campo}' debe ser mayor que cero.")
        numeros[campo] = valor

    # --- Enumeraciones: género y objetivo ---
    genero = str(payload["genero"]).strip().lower()
    if genero not in GENEROS_VALIDOS:
        raise ValueError(
            f"El campo 'genero' debe ser uno de: {list(GENEROS_VALIDOS)}."
        )

    objetivo = str(payload["objetivo"]).strip().lower()
    if objetivo not in AJUSTE_POR_OBJETIVO:
        raise ValueError(
            f"El campo 'objetivo' debe ser uno de: {list(AJUSTE_POR_OBJETIVO)}."
        )

    # --- 1. TMB (Mifflin-St Jeor) ---
    tmb = 10 * numeros["peso"] + 6.25 * numeros["altura"] - 5 * numeros["edad"]
    tmb += 5 if genero == "hombre" else -161

    # --- 2. Gasto calórico total diario (TDEE) ---
    tdee = tmb * numeros["actividad"]

    # --- 3. Ajuste según objetivo -> calorías objetivo ---
    min_calorias = tdee + AJUSTE_POR_OBJETIVO[objetivo]

    # --- 4. Reparto de macronutrientes ---
    min_proteinas = numeros["peso"] * 2.0
    max_grasas = (min_calorias * 0.25) / 9
    calorias_restantes = min_calorias - (min_proteinas * 4) - (max_grasas * 9)
    min_carbohidratos = calorias_restantes / 4
    max_carbohidratos = min_carbohidratos + 50

    return {
        "min_calorias": round(min_calorias, 2),
        "min_proteinas": round(min_proteinas, 2),
        "min_carbohidratos": round(min_carbohidratos, 2),
        "max_carbohidratos": round(max_carbohidratos, 2),
        "max_grasas": round(max_grasas, 2),
        "max_porciones_por_alimento": 3,
    }


# ---------------------------------------------------------------------------
# 4. MODELO DE OPTIMIZACIÓN (MILP)
# ---------------------------------------------------------------------------
def resolver_indices(df: pd.DataFrame, nombres, etiqueta: str) -> list[int]:
    """
    Traduce nombres de alimentos a índices de fila (sin distinguir mayúsculas
    ni espacios sobrantes). Lanza ValueError si alguno no existe.
    """
    if not nombres:
        return []

    mapa = {
        str(nombre).strip().lower(): i
        for i, nombre in enumerate(df["Alimento"])
    }

    indices, desconocidos = [], []
    for nombre in nombres:
        clave = str(nombre).strip().lower()
        if clave in mapa:
            indices.append(mapa[clave])
        else:
            desconocidos.append(str(nombre))

    if desconocidos:
        raise ValueError(
            f"Alimentos {etiqueta} no encontrados en alimentos.csv: {desconocidos}"
        )

    return indices


def resolver_dieta(
    min_calorias,
    min_proteinas,
    min_carbohidratos,
    max_carbohidratos,
    max_grasas,
    max_porciones_por_alimento,
    presupuesto_maximo=None,
    alimentos_obligatorios=None,
    alimentos_excluidos=None,
) -> dict:
    """
    Construye y resuelve el MILP.

    Lanza ModeloNoOptimo si el solver no llega a una solución óptima.
    Devuelve un dict serializable a JSON cuando hay óptimo.
    """
    # Nombre único por petición: CBC crea archivos temporales con el nombre
    # del problema; con peticiones concurrentes un nombre fijo provocaría
    # colisiones entre requests.
    problema = pulp.LpProblem(f"Dieta_{uuid.uuid4().hex[:8]}", pulp.LpMinimize)

    # --- Variables de decisión ---
    # x_i = porciones del alimento i.
    #   lowBound=0  -> no se compran cantidades negativas.
    #   upBound=M    -> cota superior: ninguna dieta puede pedir más de M
    #                   porciones del mismo alimento (restricción de caja).
    #   cat="Integer"-> variable entera: convierte el modelo en MILP.
    x = {
        i: pulp.LpVariable(
            name=f"x_{i}",
            lowBound=0,
            upBound=max_porciones_por_alimento,
            cat="Integer",
        )
        for i in range(len(df))
    }

    # --- Función objetivo ---
    # Minimizar el costo total: suma lineal de costo unitario * porciones.
    problema += pulp.lpSum(df.loc[i, "Costo"] * x[i] for i in x), "Costo_Total"

    # --- Restricciones nutricionales ---
    # Cada una es una suma ponderada (lineal) de las variables.
    problema += (
        pulp.lpSum(df.loc[i, "Calorias"] * x[i] for i in x) >= min_calorias,
        "Minimo_Calorias",
    )
    problema += (
        pulp.lpSum(df.loc[i, "Proteinas"] * x[i] for i in x) >= min_proteinas,
        "Minimo_Proteinas",
    )
    problema += (
        pulp.lpSum(df.loc[i, "Carbohidratos"] * x[i] for i in x)
        >= min_carbohidratos,
        "Minimo_Carbohidratos",
    )
    # Techo de carbohidratos: evita dietas "baratas" basadas solo en
    # cereales y tubérculos, que disparan los carbohidratos muy por encima
    # de lo razonable aunque el costo sea mínimo.
    problema += (
        pulp.lpSum(df.loc[i, "Carbohidratos"] * x[i] for i in x)
        <= max_carbohidratos,
        "Maximo_Carbohidratos",
    )
    problema += (
        pulp.lpSum(df.loc[i, "Grasas"] * x[i] for i in x) <= max_grasas,
        "Maximo_Grasas",
    )

    # --- Restricciones opcionales ---
    # 1) Presupuesto máximo: cota superior del costo total.
    if presupuesto_maximo is not None:
        problema += (
            pulp.lpSum(df.loc[i, "Costo"] * x[i] for i in x) <= presupuesto_maximo,
            "Presupuesto_Maximo",
        )

    # Traducimos nombres de alimentos a índices de variable.
    obligatorios = resolver_indices(df, alimentos_obligatorios, "obligatorios")
    excluidos = resolver_indices(df, alimentos_excluidos, "excluidos")

    if set(obligatorios) & set(excluidos):
        raise ValueError("Un alimento no puede ser obligatorio y excluido a la vez.")

    # 2) Alimentos obligatorios: al menos una porción de cada uno.
    for i in obligatorios:
        problema += x[i] >= 1, f"Obligatorio_x_{i}"

    # 3) Alimentos excluidos: exactamente cero porciones.
    for i in excluidos:
        problema += x[i] == 0, f"Excluido_x_{i}"

    # --- Resolución ---
    # CBC aplica branch-and-bound sobre la relajación lineal. msg=False
    # silencia el log. (No se usa threads=1: en esta versión de CBC en
    # Windows el solver se cuelga con ese parámetro.)
    problema.solve(pulp.PULP_CBC_CMD(msg=False))

    estado = pulp.LpStatus[problema.status]

    # Si el politopo factible es vacío (o el modelo no se resolvió), no hay
    # solución que reportar. Se propaga como excepción para que la capa HTTP
    # decida el código de respuesta.
    if problema.status != pulp.LpStatusOptimal:
        raise ModeloNoOptimo(estado)

    # --- Extracción de resultados ---
    # int(...) porque las variables ya son enteras (evita devolver 7.0).
    porciones = {i: int(round(x[i].value() or 0)) for i in x}

    # Solo alimentos efectivamente comprados (porciones > 0).
    alimentos = [
        {
            "alimento": str(df.loc[i, "Alimento"]),
            "porciones": cantidad,
            "costo_unitario": float(df.loc[i, "Costo"]),
            "costo_subtotal": round(float(df.loc[i, "Costo"]) * cantidad, 2),
        }
        for i, cantidad in porciones.items()
        if cantidad > 0
    ]

    # Resumen nutricional de la solución: permite al frontend mostrar el
    # cumplimiento real de cada restricción (útil para ver holguras).
    # float(...) porque pandas devuelve numpy.int64/float64 y Flask no los
    # puede serializar a JSON.
    resumen = {
        nutriente: round(
            float(
                sum(
                    df.loc[i, nutriente] * cantidad
                    for i, cantidad in porciones.items()
                )
            ),
            2,
        )
        for nutriente in NUTRIENTES
    }

    return {
        "estado": estado,
        "costo_total": round(float(pulp.value(problema.objective)), 2),
        "alimentos": alimentos,
        "resumen_nutricional": resumen,
    }


# ---------------------------------------------------------------------------
# 5. ENDPOINT
# ---------------------------------------------------------------------------
@app.post("/optimizar")
def optimizar():
    payload = request.get_json(silent=True)  # None si el body no es JSON

    try:
        parametros = {
            **validar_parametros(payload),
            **leer_parametros_opcionales(payload),
        }
        resultado = resolver_dieta(**parametros)
    except ValueError as error:
        # Error de entrada del cliente: 400.
        return jsonify({"error": str(error)}), 400
    except ModeloNoOptimo as error:
        # Resultado matemático válido: el sistema de restricciones es
        # incompatible. Se registra el estado real del solver para depurar.
        app.logger.warning(
            "Modelo no óptimo (%s) con payload=%s", error.estado, payload
        )
        return jsonify({"estado": "Error", "mensaje": MENSAJE_IMPOSSIBLE}), 422
    except pulp.PulpSolverError as error:
        # Falla interna del solver (no del modelo): 500.
        return jsonify({"error": f"Error del solver: {error}"}), 500

    return jsonify(resultado), 200


@app.get("/alimentos")
def listar_alimentos():
    """Devuelve los nombres de alimentos disponibles para los selectores."""
    return jsonify({"alimentos": [str(nombre) for nombre in df["Alimento"]]}), 200


@app.post("/optimizar_perfil")
def optimizar_perfil():
    """
    Calcula los parámetros nutricionales desde un perfil antropométrico
    (TMB Mifflin-St Jeor, TDEE, ajuste por objetivo y reparto de macros) y
    resuelve el mismo MILP que /optimizar.
    """
    payload = request.get_json(silent=True)  # None si el body no es JSON

    try:
        parametros = {
            **calcular_parametros_desde_perfil(payload),
            **leer_parametros_opcionales(payload),
        }
        resultado = resolver_dieta(**parametros)
    except ValueError as error:
        # Datos faltantes o inválidos: 400.
        return jsonify({"error": str(error)}), 400
    except ModeloNoOptimo as error:
        # Perfil válido pero metas imposibles con los alimentos actuales.
        app.logger.warning(
            "Modelo no óptimo (%s) con payload=%s", error.estado, payload
        )
        return jsonify({"estado": "Error", "mensaje": MENSAJE_IMPOSSIBLE}), 422
    except pulp.PulpSolverError as error:
        return jsonify({"error": f"Error del solver: {error}"}), 500

    return jsonify(resultado), 200


if __name__ == "__main__":
    # 0.0.0.0 permite que el compañero se conecte desde otra máquina.
    app.run(host="0.0.0.0", port=5000, debug=True)
