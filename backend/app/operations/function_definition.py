"""
FunctionDefinitionQuery — ``pg_get_functiondef`` + prefill metadata for one
routine, located by schema + name + its identity signature. Mirrors
``ViewDefinitionQuery``'s layout.

The routine is resolved by matching schema, name, and an exact string
equality against ``pg_get_function_identity_arguments(oid)`` — the same
function ``ListFunctionsQuery`` uses to produce the ``signature`` a caller
passes back in, so the two are always comparing like with like. This is
deliberately **not** a ``::regprocedure`` cast of the reconstructed
``"schema"."name"(signature)`` text: ``pg_get_function_identity_arguments``
includes each argument's declared name (e.g. ``"a integer, b integer"``) when
the routine was created with named arguments, but ``regprocedure``'s parser
only accepts a bare type list (``"integer, integer"``) and raises a syntax
error on a named-argument identity string — a real integration bug found
manually exercising this route against a function with named arguments.
Matching by identity-arguments-string-equality sidesteps that parser
mismatch entirely and still pins the exact overload, never re-derived from a
bare name.
"""

from __future__ import annotations

import asyncpg

from ..errors import NotFound
from .base import CatalogQuery


class FunctionDefinitionQuery(CatalogQuery):
    """
    Fetch a function/procedure's ``pg_get_functiondef`` definition SQL.
    """

    _SQL = (
        "SELECT pg_get_functiondef(p.oid) AS definition, "
        "p.prokind = 'p' AS is_procedure, "
        "pg_get_function_identity_arguments(p.oid) AS signature, "
        "l.lanname AS language "
        "FROM pg_catalog.pg_proc p "
        "JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace "
        "JOIN pg_catalog.pg_language l ON l.oid = p.prolang "
        "WHERE n.nspname = $1 AND p.proname = $2 "
        "AND pg_get_function_identity_arguments(p.oid) = $3"
    )

    def __init__(self, conn: asyncpg.Connection, schema: str, name: str, signature: str) -> None:
        """
        Capture the connection and the routine's identity.

        Args:
            conn: the connection to introspect on.
            schema: the routine's schema.
            name: the routine's name.
            signature: the identity-argument list (from
                ``ListFunctionsQuery``), disambiguating overloads.
        """
        super().__init__(conn, schema, name, signature)
        self._schema: str = schema
        self._name: str = name
        self._signature: str = signature

    def get_result(self) -> dict:
        """
        Return the routine's definition and prefill metadata.

        Raises:
            RuntimeError: if called before ``apply()``.
            NotFound: if no function/procedure matches the signature.

        Returns:
            ``{"definition": str, "isProcedure": bool, "signature": str,
            "language": str}``.
        """
        rows = self._rows()

        if not rows:
            raise NotFound(f"Function/procedure '{self._schema}.{self._name}({self._signature})' not found")

        row = rows[0]

        return {
            "definition": row["definition"],
            "isProcedure": row["is_procedure"],
            "signature": row["signature"],
            "language": row["language"],
        }
