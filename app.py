"""
API Flask del Problema de la Dieta.

Endpoint:
    POST /optimizar
    Body JSON: {"min_calorias", "min_proteinas", "min_carbohidratos", "max_grasas"}
    Respuesta: alimentos seleccionados (porciones enteras > 0) y costo total.

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

CAMPOS_ENTRADA = ("min_calorias", "min_proteinas", "min_carbohidratos", "max_grasas")
NUTRIENTES = ("Calorias", "Proteinas", "Carbohidratos", "Grasas")


def cargar_alimentos() -> pd.DataFrame:
    """Lee y valida alimentos.csv una única vez."""
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

# CORS(app) permite peticiones desde cualquier origen (útil en desarrollo
# mientras el frontend corre en otro puerto, p. ej. Vite o Live Server).
CORS(app)


# ---------------------------------------------------------------------------
# 3. VALIDACIÓN DE PARÁMETROS
# ---------------------------------------------------------------------------
def validar_parametros(payload) -> dict:
    """Comprueba el JSON de entrada y devuelve los 4 valores como float."""
    if not isinstance(payload, dict):
        raise ValueError("El cuerpo de la petición debe ser un objeto JSON.")

    faltantes = [campo for campo in CAMPOS_ENTRADA if campo not in payload]
    if faltantes:
        raise ValueError(f"Faltan campos obligatorios: {faltantes}")

    valores = {}
    for campo in CAMPOS_ENTRADA:
        try:
            valor = float(payload[campo])
        except (TypeError, ValueError):
            raise ValueError(f"El campo '{campo}' debe ser numérico.") from None
        if valor < 0:
            raise ValueError(f"El campo '{campo}' no puede ser negativo.")
        valores[campo] = valor

    return valores


# ---------------------------------------------------------------------------
# 4. MODELO DE OPTIMIZACIÓN (misma lógica que modelo.py, con valores dinámicos)
# ---------------------------------------------------------------------------
def resolver_dieta(min_calorias, min_proteinas, min_carbohidratos, max_grasas) -> dict:
    """Resuelve el problema entero y devuelve un diccionario serializable."""

    # Nombre único: evita que dos peticiones simultáneas compartan los
    # archivos temporales que genera CBC.
    problema = pulp.LpProblem(f"Dieta_{uuid.uuid4().hex[:8]}", pulp.LpMinimize)

    # Variables enteras >= 0: número de porciones de cada alimento.
    x = {
        i: pulp.LpVariable(name=f"x_{i}", lowBound=0, cat="Integer")
        for i in range(len(df))
    }

    # Función objetivo: minimizar el costo total.
    problema += pulp.lpSum(df.loc[i, "Costo"] * x[i] for i in x), "Costo_Total"

    # Restricciones con los valores recibidos por JSON.
    problema += (
        pulp.lpSum(df.loc[i, "Calorias"] * x[i] for i in x) >= min_calorias,
        "Minimo_Calorias",
    )
    problema += (
        pulp.lpSum(df.loc[i, "Proteinas"] * x[i] for i in x) >= min_proteinas,
        "Minimo_Proteinas",
    )
    problema += (
        pulp.lpSum(df.loc[i, "Grasas"] * x[i] for i in x) <= max_grasas,
        "Maximo_Grasas",
    )
    problema += (
        pulp.lpSum(df.loc[i, "Carbohidratos"] * x[i] for i in x) >= min_carbohidratos,
        "Minimo_Carbohidratos",
    )

    problema.solve(pulp.PULP_CBC_CMD(msg=False, threads=1))

    estado = pulp.LpStatus[problema.status]

    # Si no hay óptimo (infactible, ilimitado...), no hay porciones que dar.
    if problema.status != pulp.LpStatusOptimal:
        return {
            "estado": estado,
            "costo_total": None,
            "alimentos": [],
            "resumen_nutricional": None,
        }

    # Porciones enteras del solver (int para no devolver 7.0).
    porciones = {i: int(round(x[i].value() or 0)) for i in x}

    # Solo alimentos realmente comprados, con su costo unitario y subtotal.
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

    # Resumen nutricional: sirve al frontend para mostrar el cumplimiento.
    # Se convierte a float porque pandas devuelve numpy.int64/float64 y Flask
    # no puede serializar esos tipos a JSON.
    resumen = {
        nutriente: round(
            float(sum(df.loc[i, nutriente] * cantidad for i, cantidad in porciones.items())),
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
    payload = request.get_json(silent=True)  # None si el body no es JSON válido

    try:
        parametros = validar_parametros(payload)
        resultado = resolver_dieta(**parametros)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except pulp.PulpSolverError as error:
        return jsonify({"error": f"Error del solver: {error}"}), 500

    # 200 si hay óptimo; 422 si el modelo es infactible con esos valores.
    codigo = 200 if resultado["estado"] == "Optimal" else 422
    return jsonify(resultado), codigo


if __name__ == "__main__":
    # 0.0.0.0 permite que tu compañero se conecte desde otra máquina de la red.
    app.run(host="0.0.0.0", port=5000, debug=True)
