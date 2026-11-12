"""
Problema de la Dieta - Modelo de Programación Lineal Entera (MILP) por consola
==============================================================================

Objetivo:
    Minimizar el costo total de la compra de alimentos satisfaciendo
    requisitos mínimos de calorías, proteínas y carbohidratos, un techo
    de carbohidratos y de grasas, y un máximo de porciones por alimento.

Modelo matemático:
    Variables:  x_i ∈ Z,  0 <= x_i <= M   -> porciones del alimento i.
                La "porción" depende de cada alimento (100 g de pollo,
                1 huevo, 100 g de arroz, etc., según alimentos.csv).
    Minimizar:  sum(Costo_i * x_i)
    Sujeto a:
        sum(Calorias_i       * x_i) >= min_calorias
        sum(Proteinas_i      * x_i) >= min_proteinas
        sum(Carbohidratos_i  * x_i) >= min_carbohidratos
        sum(Carbohidratos_i  * x_i) <= max_carbohidratos
        sum(Grasas_i         * x_i) <= max_grasas
        x_i <= M                     (cota superior por alimento)

Teoría (Investigación de Operaciones):
    - La función objetivo y las restricciones son LINEALES.
    - Las variables son ENTERAS, por lo que el modelo es un MILP y se
      resuelve con branch-and-bound: se parte de la relajación lineal
      (x_i reales), que da una cota inferior del costo, y se ramifica
      hasta hallar la mejor solución entera. Por eso el óptimo entero
      siempre es >= al óptimo continuo ("costo de la integralidad").
    - upBound=M es una cota de caja declarada en la variable: el solver la
      usa para fijar el dominio y podar el árbol de búsqueda. Además aporta
      realismo (evita "10 huevos al día") y garantiza que el problema no
      sea no acotado al minimizar.
    - El precio sombra (dual) de cada restricción nutricional en la
      relajación lineal indica cuánto subiría el costo mínimo si se exigiera
      una unidad más de ese nutriente.

Uso:
    python modelo.py
    python modelo.py --min-calorias 2200 --max-porciones 2
    python modelo.py --min-carbohidratos 250 --max-carbohidratos 100   (infactible)
    python modelo.py --presupuesto 2.0 --obligatorio "Maní" --excluir "Lentejas (secas)"

Requisitos:
    pip install pandas "pulp<4"
"""

import argparse
import sys
from pathlib import Path

import pandas as pd
import pulp


# ---------------------------------------------------------------------------
# 1. CARGA DE DATOS
# ---------------------------------------------------------------------------
# Ruta relativa al script: funciona sin importar desde qué carpeta se ejecute.
RUTA_DATOS = Path(__file__).resolve().parent / "alimentos.csv"

COLUMNAS_REQUERIDAS = [
    "Alimento",
    "Costo",
    "Calorias",
    "Proteinas",
    "Carbohidratos",
    "Grasas",
]

NUTRIENTES = ("Calorias", "Proteinas", "Carbohidratos", "Grasas")

# Restricciones nutricionales y su lectura económica (precios sombra).
RESTRICCIONES_NUTRICIONALES = (
    ("Minimo_Calorias", "Calorias", "minimo", "kcal"),
    ("Minimo_Proteinas", "Proteinas", "minimo", "g"),
    ("Minimo_Carbohidratos", "Carbohidratos", "minimo", "g"),
    ("Maximo_Carbohidratos", "Carbohidratos", "maximo", "g"),
    ("Maximo_Grasas", "Grasas", "maximo", "g"),
)

MENSAJE_IMPOSSIBLE = (
    "Tus requerimientos son matemáticamente imposibles de cumplir "
    "con los alimentos actuales."
)


def cargar_alimentos() -> pd.DataFrame:
    """Lee y valida alimentos.csv (misma validación que la API)."""
    df = pd.read_csv(RUTA_DATOS)
    df.columns = [columna.strip() for columna in df.columns]

    faltantes = [c for c in COLUMNAS_REQUERIDAS if c not in df.columns]
    if faltantes:
        raise ValueError(f"Faltan columnas en alimentos.csv: {faltantes}")

    df = df.dropna(how="all").reset_index(drop=True)
    if df.empty:
        raise ValueError("El archivo alimentos.csv no contiene datos.")

    return df


# ---------------------------------------------------------------------------
# 2. PARÁMETROS POR CONSOLA
# ---------------------------------------------------------------------------
# Los valores por defecto coinciden con los del ejemplo de la API, así que
# "python modelo.py" sin argumentos funciona igual que antes.
def parsear_argumentos(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Problema de la Dieta (MILP): minimiza el costo de la dieta.",
    )
    parser.add_argument(
        "--min-calorias", type=float, default=2500.0,
        help="Calorías mínimas totales (por defecto: 2500).",
    )
    parser.add_argument(
        "--min-proteinas", type=float, default=130.0,
        help="Proteínas mínimas en gramos (por defecto: 130).",
    )
    parser.add_argument(
        "--min-carbohidratos", type=float, default=250.0,
        help="Carbohidratos mínimos en gramos (por defecto: 250).",
    )
    parser.add_argument(
        "--max-carbohidratos", type=float, default=350.0,
        help="Carbohidratos máximos en gramos (por defecto: 350).",
    )
    parser.add_argument(
        "--max-grasas", type=float, default=70.0,
        help="Grasas máximas en gramos (por defecto: 70).",
    )
    parser.add_argument(
        "--max-porciones", type=int, default=3,
        help="Máximo de porciones por alimento (entero, por defecto: 3).",
    )
    # --- Restricciones opcionales ---
    parser.add_argument(
        "--presupuesto", type=float, default=None,
        help="Presupuesto máximo total en costo (opcional).",
    )
    parser.add_argument(
        "--obligatorio", action="append", metavar="ALIMENTO",
        help="Alimento obligatorio, al menos 1 porción (repetible).",
    )
    parser.add_argument(
        "--excluir", action="append", metavar="ALIMENTO",
        help="Alimento excluido, 0 porciones (repetible).",
    )
    parser.add_argument(
        "--sensibilidad", action="store_true",
        help="Muestra precios sombra de la relajación lineal (duales).",
    )

    args = parser.parse_args(argv)

    # Validaciones equivalentes a las de la API (400 en HTTP).
    for nombre, valor in (
        ("--min-calorias", args.min_calorias),
        ("--min-proteinas", args.min_proteinas),
        ("--min-carbohidratos", args.min_carbohidratos),
        ("--max-carbohidratos", args.max_carbohidratos),
        ("--max-grasas", args.max_grasas),
    ):
        if valor < 0:
            parser.error(f"{nombre} no puede ser negativo.")

    if args.max_porciones < 1:
        parser.error("--max-porciones debe ser un entero mayor o igual a 1.")

    if args.presupuesto is not None and args.presupuesto < 0:
        parser.error("--presupuesto no puede ser negativo.")

    return args


# ---------------------------------------------------------------------------
# 3. MODELO DE OPTIMIZACIÓN (MILP)
# ---------------------------------------------------------------------------
def resolver_indices(df: pd.DataFrame, nombres, etiqueta: str) -> list[int]:
    """
    Traduce nombres de alimentos a índices de fila.

    La comparación ignora mayúsculas y espacios sobrantes. Lanza ValueError
    si algún nombre no existe en alimentos.csv.
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


def construir_problema(
    df: pd.DataFrame,
    min_calorias: float,
    min_proteinas: float,
    min_carbohidratos: float,
    max_carbohidratos: float,
    max_grasas: float,
    max_porciones_por_alimento: int,
    presupuesto_maximo: float | None = None,
    alimentos_obligatorios: list[str] | None = None,
    alimentos_excluidos: list[str] | None = None,
    continua: bool = False,
):
    """
    Construye el modelo lineal (sin resolverlo).

    continua=False -> MILP con variables enteras (modelo real).
    continua=True  -> relajación lineal, necesaria para obtener los precios
                      sombra: CBC solo reporta duales en problemas continuos.

    Devuelve (problema, x).
    """
    # LpMinimize: el solver busca el menor costo posible.
    problema = pulp.LpProblem("Problema_de_la_Dieta", pulp.LpMinimize)

    # --- Variables de decisión ---
    # lowBound=0  -> no se compran cantidades negativas.
    # upBound=M    -> máximo de porciones del mismo alimento (cota de caja).
    # cat="Integer"-> variables enteras: el modelo es MILP, no LP continuo.
    categoria = "Continuous" if continua else "Integer"
    x = {
        i: pulp.LpVariable(
            name=f"x_{i}",
            lowBound=0,
            upBound=max_porciones_por_alimento,
            cat=categoria,
        )
        for i in range(len(df))
    }

    # --- Función objetivo ---
    # Costo total = suma de (costo unitario * porciones compradas).
    problema += pulp.lpSum(df.loc[i, "Costo"] * x[i] for i in x), "Costo_Total"

    # --- Restricciones ---
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

    return problema, x


def resolver_dieta(
    df: pd.DataFrame,
    min_calorias: float,
    min_proteinas: float,
    min_carbohidratos: float,
    max_carbohidratos: float,
    max_grasas: float,
    max_porciones_por_alimento: int,
    presupuesto_maximo: float | None = None,
    alimentos_obligatorios: list[str] | None = None,
    alimentos_excluidos: list[str] | None = None,
) -> dict:
    """
    Construye y resuelve el MILP. Devuelve un dict con los resultados o
    {"estado": <estado no óptimo>} si no hay solución.

    Parámetros opcionales:
        presupuesto_maximo: cota superior del costo total (<=).
        alimentos_obligatorios: nombres que deben comprarse al menos 1 vez.
        alimentos_excluidos: nombres que no pueden comprarse (x_i == 0).
    """
    problema, x = construir_problema(
        df,
        min_calorias=min_calorias,
        min_proteinas=min_proteinas,
        min_carbohidratos=min_carbohidratos,
        max_carbohidratos=max_carbohidratos,
        max_grasas=max_grasas,
        max_porciones_por_alimento=max_porciones_por_alimento,
        presupuesto_maximo=presupuesto_maximo,
        alimentos_obligatorios=alimentos_obligatorios,
        alimentos_excluidos=alimentos_excluidos,
    )

    # --- Resolución ---
    # CBC resuelve con branch-and-bound. msg=False silencia su log.
    # (No se usa threads=1: con esta versión de CBC en Windows se cuelga.)
    problema.solve(pulp.PULP_CBC_CMD(msg=False))

    estado = pulp.LpStatus[problema.status]

    # Sin óptimo no hay porciones que reportar.
    if problema.status != pulp.LpStatusOptimal:
        return {"estado": estado}

    # int(...) porque las variables ya son enteras.
    porciones = {i: int(round(x[i].value() or 0)) for i in x}

    return {
        "estado": estado,
        "porciones": porciones,
        "nombres": df["Alimento"].astype(str).tolist(),
        "costo_total": float(pulp.value(problema.objective)),
        "resumen_nutricional": {
            nutriente: float(
                sum(df.loc[i, nutriente] * cantidad for i, cantidad in porciones.items())
            )
            for nutriente in NUTRIENTES
        },
    }


def calcular_sensibilidad(
    df: pd.DataFrame,
    costo_total: float | None = None,
    **parametros,
) -> dict:
    """
    Resuelve la relajación lineal y extrae los precios sombra (duales).

    - Restricción de mínimo (>=): π >= 0, costo marginal de exigir +1 unidad.
    - Restricción de máximo (<=): π <= 0, ahorro marginal de relajar el techo.

    Lanza pulp.PulpSolverError si CBC falla (igual que resolver_dieta).
    """
    problema, _ = construir_problema(df, continua=True, **parametros)
    problema.solve(pulp.PULP_CBC_CMD(msg=False))

    if problema.status != pulp.LpStatusOptimal:
        return {
            "costo_relajado": None,
            "precios_sombra": [],
            "mensaje": "El modelo no tiene solución óptima; no hay duales.",
        }

    costo_relajado = float(pulp.value(problema.objective) or 0)

    precios = []
    for nombre, nutriente, tipo, unidad in RESTRICCIONES_NUTRICIONALES:
        restriccion = problema.constraints.get(nombre)
        pi = None if restriccion is None else getattr(restriccion, "pi", None)
        if pi is None:
            continue
        pi = float(pi)
        precios.append(
            {
                "restriccion": nombre,
                "nutriente": nutriente,
                "tipo": tipo,
                "unidad": unidad,
                "por_unidad": pi,
                "por_100_unidades": pi * 100,
                "activa": abs(pi) > 1e-9,
            }
        )

    resultado = {
        "costo_relajado": costo_relajado,
        "precios_sombra": precios,
    }
    if costo_total is not None:
        resultado["costo_integralidad"] = costo_total - costo_relajado
    return resultado


# ---------------------------------------------------------------------------
# 4. PRESENTACIÓN EN CONSOLA
# ---------------------------------------------------------------------------
def imprimir_resultados(resultado: dict, args: argparse.Namespace) -> None:
    print("=" * 60)
    print("PROBLEMA DE LA DIETA - RESULTADOS")
    print("=" * 60)
    print(
        f"Parámetros: cal>={args.min_calorias:g} | prot>={args.min_proteinas:g} | "
        f"carb [{args.min_carbohidratos:g}, {args.max_carbohidratos:g}] | "
        f"grasa<={args.max_grasas:g} | max porciones={args.max_porciones}"
    )

    # Restricciones opcionales activas (si las hay).
    extras = []
    if args.presupuesto is not None:
        extras.append(f"presupuesto<={args.presupuesto:g}")
    if args.obligatorio:
        extras.append("obligatorios=" + ", ".join(args.obligatorio))
    if args.excluir:
        extras.append("excluidos=" + ", ".join(args.excluir))
    if extras:
        print("Opcionales: " + " | ".join(extras))
    print(f"Estado de la resolución: {resultado['estado']}")
    print()

    if resultado["estado"] != "Optimal":
        # Mismo mensaje que devuelve la API en el HTTP 422.
        print(f"Error: {MENSAJE_IMPOSSIBLE}")
        return

    seleccionados = {
        i: cantidad
        for i, cantidad in resultado["porciones"].items()
        if cantidad > 0
    }

    print("Alimentos seleccionados:")
    if seleccionados:
        print(f"  {'Alimento':<25} {'Porciones':>12}")
        print("  " + "-" * 38)
        for i, cantidad in seleccionados.items():
            print(f"  {resultado['nombres'][i]:<25} {cantidad:>12d}")
    else:
        print("  (ninguno)")

    print()
    print(f"Costo total óptimo: ${resultado['costo_total']:,.2f}")

    print()
    print("Resumen nutricional de la solución:")
    for nutriente, total in resultado["resumen_nutricional"].items():
        print(f"  {nutriente:<15} {total:>10.2f}")


def imprimir_sensibilidad(sensibilidad: dict) -> None:
    """Muestra los precios sombra de la relajación lineal."""
    print()
    print("=" * 60)
    print("ANÁLISIS DE SENSIBILIDAD (RELAJACIÓN LINEAL)")
    print("=" * 60)

    if sensibilidad.get("costo_relajado") is None:
        print(sensibilidad.get("mensaje", "No disponible."))
        return

    print(f"Costo continuo (cota inferior): ${sensibilidad['costo_relajado']:,.2f}")
    if "costo_integralidad" in sensibilidad:
        print(
            "Costo de la integralidad:       "
            f"${sensibilidad['costo_integralidad']:,.2f}"
        )

    print()
    print("Precio sombra por cada 100 unidades adicionales:")
    for precio in sensibilidad["precios_sombra"]:
        efecto = "sube" if precio["por_unidad"] >= 0 else "baja"
        estado = "activa" if precio["activa"] else "no activa"
        print(
            f"  {precio['nutriente']:<15} {precio['tipo']:<7} "
            f"({precio['unidad']:<4}) ${precio['por_100_unidades']:>8.4f} "
            f"({efecto}, {estado})"
        )


# ---------------------------------------------------------------------------
# 5. PUNTO DE ENTRADA
# ---------------------------------------------------------------------------
def main(argv=None) -> int:
    args = parsear_argumentos(argv)
    df = cargar_alimentos()

    parametros = dict(
        min_calorias=args.min_calorias,
        min_proteinas=args.min_proteinas,
        min_carbohidratos=args.min_carbohidratos,
        max_carbohidratos=args.max_carbohidratos,
        max_grasas=args.max_grasas,
        max_porciones_por_alimento=args.max_porciones,
        presupuesto_maximo=args.presupuesto,
        alimentos_obligatorios=args.obligatorio,
        alimentos_excluidos=args.excluir,
    )

    try:
        resultado = resolver_dieta(df, **parametros)
    except ValueError as error:
        # Nombre de alimento inexistente o combinación contradictoria.
        print(f"Error: {error}")
        return 2

    imprimir_resultados(resultado, args)

    if args.sensibilidad and resultado["estado"] == "Optimal":
        try:
            sensibilidad = calcular_sensibilidad(
                df,
                costo_total=resultado["costo_total"],
                **parametros,
            )
        except ValueError as error:
            print(f"Error: {error}")
            return 2
        imprimir_sensibilidad(sensibilidad)

    # Código de salida 1 si no hubo óptimo: útil para scripts/CI.
    return 0 if resultado["estado"] == "Optimal" else 1


if __name__ == "__main__":
    sys.exit(main())
