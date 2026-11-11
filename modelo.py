"""
Problema de la Dieta - Modelo de Programación Lineal Entera
===========================================================

Objetivo:
    Minimizar el costo total de la compra de alimentos satisfaciendo
    requisitos mínimos de calorías, proteínas y carbohidratos, y un
    máximo de grasas.

Modelo matemático:
    Variables:  x_i entero >= 0  -> porciones del alimento i a comprar.
                La "porción" depende de cada alimento (100 g de pollo,
                1 huevo, 100 g de arroz, etc., según alimentos.csv).
    Minimizar:  sum(Costo_i * x_i)
    Sujeto a:
        sum(Calorias_i       * x_i) >= 2500
        sum(Proteinas_i      * x_i) >= 130
        sum(Carbohidratos_i  * x_i) >= 250
        sum(Grasas_i         * x_i) <= 70

Requisitos:
    pip install pandas "pulp<4"
    (La API clásica de PuLP usada aquí no es compatible con PuLP 4.x.)
"""

from pathlib import Path

import pandas as pd
import pulp


# ---------------------------------------------------------------------------
# 1. CARGA DE DATOS
# ---------------------------------------------------------------------------
# Se construye la ruta a partir de la ubicación del script para que funcione
# sin importar desde qué carpeta se ejecute el programa.
RUTA_DATOS = Path(__file__).resolve().parent / "alimentos.csv"

# Leemos el CSV con pandas. Cada fila será un alimento y cada columna un
# atributo nutricional o el costo.
df = pd.read_csv(RUTA_DATOS)

# Normalizamos los nombres de las columnas (sin espacios accidentales) para
# evitar errores al acceder a ellas más adelante.
df.columns = [columna.strip() for columna in df.columns]

# Validación temprana: si falta alguna columna requerida, es mejor fallar aquí
# con un mensaje claro que obtener un KeyError más adelante.
COLUMNAS_REQUERIDAS = [
    "Alimento",
    "Costo",
    "Calorias",
    "Proteinas",
    "Carbohidratos",
    "Grasas",
]
faltantes = [col for col in COLUMNAS_REQUERIDAS if col not in df.columns]
if faltantes:
    raise ValueError(f"Faltan columnas en alimentos.csv: {faltantes}")

# Eliminamos filas completamente vacías (por ejemplo, líneas en blanco al final
# del archivo) para no crear variables innecesarias.
df = df.dropna(how="all").reset_index(drop=True)

if df.empty:
    raise ValueError("El archivo alimentos.csv no contiene datos.")


# ---------------------------------------------------------------------------
# 2. DEFINICIÓN DEL PROBLEMA
# ---------------------------------------------------------------------------
# LpMinimize indica que el solver buscará el menor valor posible de la función
# objetivo (en este caso, el menor costo).
problema = pulp.LpProblem("Problema_de_la_Dieta", pulp.LpMinimize)


# ---------------------------------------------------------------------------
# 3. VARIABLES DE DECISIÓN
# ---------------------------------------------------------------------------
# x[i] = número de porciones ENTERAS del alimento i a comprar.
#   - lowBound=0    -> no se pueden comprar cantidades negativas.
#   - cat="Integer" -> variable entera: el modelo pasa de PL a PL entero
#                      mixto (MILP). CBC resuelve la relajación lineal y
#                      luego aplica branch-and-bound para forzar la
#                      integralidad, por eso las porciones salen "completas".
# La "porción" se define según el nombre del alimento en el CSV
# (100 g de pollo, 1 huevo, 100 g de arroz, etc.).
# Se usan nombres simples (x_0, x_1, ...) para que el solver no tenga problemas
# con espacios, acentos o paréntesis en los nombres de los alimentos.
x = {
    i: pulp.LpVariable(name=f"x_{i}", lowBound=0, cat="Integer")
    for i in range(len(df))
}

# Diccionario auxiliar para recuperar el nombre del alimento a partir del índice.
nombres = df["Alimento"].astype(str).tolist()


# ---------------------------------------------------------------------------
# 4. FUNCIÓN OBJETIVO
# ---------------------------------------------------------------------------
# Costo total = suma de (costo unitario * porciones compradas).
problema += pulp.lpSum(df.loc[i, "Costo"] * x[i] for i in x), "Costo_Total"


# ---------------------------------------------------------------------------
# 5. RESTRICCIONES
# ---------------------------------------------------------------------------
# Restricción de calorías: al menos 2500 kcal en total.
problema += (
    pulp.lpSum(df.loc[i, "Calorias"] * x[i] for i in x) >= 2500,
    "Minimo_Calorias",
)

# Restricción de proteínas: al menos 130 g en total.
problema += (
    pulp.lpSum(df.loc[i, "Proteinas"] * x[i] for i in x) >= 130,
    "Minimo_Proteinas",
)

# Restricción de grasas: como máximo 70 g en total.
problema += (
    pulp.lpSum(df.loc[i, "Grasas"] * x[i] for i in x) <= 70,
    "Maximo_Grasas",
)

# Restricción de carbohidratos: al menos 250 g en total.
problema += (
    pulp.lpSum(df.loc[i, "Carbohidratos"] * x[i] for i in x) >= 250,
    "Minimo_Carbohidratos",
)


# ---------------------------------------------------------------------------
# 6. RESOLUCIÓN
# ---------------------------------------------------------------------------
# PULP_CBC_CMD es el solver de código abierto que viene incluido con PuLP.
# msg=False desactiva el log interno del solver para mantener limpia la salida.
solver = pulp.PULP_CBC_CMD(msg=False)
problema.solve(solver)

# pulp.LpStatus traduce el código numérico del estado a un texto legible
# ("Optimal", "Infeasible", "Unbounded", etc.).
estado = pulp.LpStatus[problema.status]


# ---------------------------------------------------------------------------
# 7. RESULTADOS
# ---------------------------------------------------------------------------
print("=" * 60)
print("PROBLEMA DE LA DIETA - RESULTADOS")
print("=" * 60)
print(f"Estado de la resolución: {estado}")
print()

if problema.status == pulp.LpStatusOptimal:
    # Como las variables son enteras, los valores del solver ya son números
    # completos: se convierten a int para no mostrarlos como "7.0".
    porciones = {i: int(round(x[i].value() or 0)) for i in x}

    # Solo mostramos los alimentos que realmente se compran (cantidad > 0).
    seleccionados = {i: cant for i, cant in porciones.items() if cant > 0}

    print("Alimentos seleccionados:")
    if seleccionados:
        print(f"  {'Alimento':<25} {'Porciones':>12}")
        print("  " + "-" * 38)
        for i, cant in seleccionados.items():
            print(f"  {nombres[i]:<25} {cant:>12d}")
    else:
        print("  (ninguno)")

    print()
    print(f"Costo total óptimo: ${pulp.value(problema.objective):,.2f}")

    # Resumen nutricional de la solución encontrada. Es útil para verificar
    # que las restricciones realmente se cumplen y qué tan ajustadas quedaron.
    print()
    print("Resumen nutricional de la solución:")
    for nutriente in ["Calorias", "Proteinas", "Carbohidratos", "Grasas"]:
        total = sum(df.loc[i, nutriente] * cant for i, cant in porciones.items())
        print(f"  {nutriente:<15} {total:>10.2f}")

else:
    # Si el modelo no tiene solución óptima, no hay cantidades que reportar.
    print("No se encontró una solución óptima. Revisa la consistencia")
    print("de las restricciones (el problema podría ser infactible).")
