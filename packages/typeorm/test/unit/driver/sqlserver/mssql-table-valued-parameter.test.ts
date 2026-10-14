import "reflect-metadata"
import { expect } from "chai"
// The mssql package has no type declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mssql = require("mssql")
import { MssqlParameter } from "../../../../src/index.js"
import type { SqlServerDriver } from "../../../../src/driver/sqlserver/SqlServerDriver"
import { SqlServerQueryRunner } from "../../../../src/driver/sqlserver/SqlServerQueryRunner"

interface NativeTable {
    name: string
    schema: string
    columns: { name: string; nullable: boolean; length?: number }[]
    rows: unknown[][]
}

describe("sqlserver > table valued parameter", () => {
    // Only the two conversion methods are used, so the driver is a small fake.
    const driver = {
        mssql,
        options: {},
        normalizeType: (column: { type: string }) => column.type,
    }
    const runner = new SqlServerQueryRunner(
        driver as unknown as SqlServerDriver,
        "master",
    )

    it("should map the tvp type to the mssql TVP type", () => {
        const type = runner["mssqlParameterToNativeParameter"](
            new MssqlParameter({}, "tvp"),
        )
        expect(type).to.equal(mssql.TVP)
    })

    it("should convert a descriptor to an mssql Table", () => {
        const table = runner["mssqlParameterToNativeValue"](
            new MssqlParameter(
                {
                    typeName: "dbo.IdName",
                    columns: [
                        { name: "Id", type: "int", nullable: false },
                        { name: "Name", type: "nvarchar", params: [50] },
                    ],
                    rows: [
                        [1, "a"],
                        [2, "b"],
                    ],
                },
                "tvp",
            ),
        ) as NativeTable

        expect(table).to.be.instanceOf(mssql.Table)
        expect(table.name).to.equal("IdName")
        expect(table.schema).to.equal("dbo")
        expect(table.columns.map((column) => column.name)).to.deep.equal([
            "Id",
            "Name",
        ])
        expect(table.columns[0].nullable).to.equal(false)
        expect(table.columns[1].length).to.equal(50)
        expect(table.rows).to.deep.equal([
            [1, "a"],
            [2, "b"],
        ])
    })

    it("should pass an mssql Table through", () => {
        const table = new mssql.Table("dbo.IdList")
        table.columns.add("Id", mssql.Int)
        expect(
            runner["mssqlParameterToNativeValue"](
                new MssqlParameter(table, "tvp"),
            ),
        ).to.equal(table)
    })

    it("should not change the value of other types", () => {
        expect(
            runner["mssqlParameterToNativeValue"](new MssqlParameter(5, "int")),
        ).to.equal(5)
    })
})
