import "reflect-metadata"
import { expect } from "chai"
import type { DataSource } from "../../../../src/data-source/DataSource"
import { MssqlParameter } from "../../../../src/driver/sqlserver/MssqlParameter"
import type { SqlServerDriver } from "../../../../src/driver/sqlserver/SqlServerDriver"
import {
    closeTestingConnections,
    createTestingConnections,
    reloadTestingDatabases,
} from "../../../utils/test-utils"
import { Post } from "./entity/Post"

describe("database schema > mssql-parameters > table valued parameters", () => {
    let dataSources: DataSource[]

    before(async () => {
        dataSources = await createTestingConnections({
            entities: [__dirname + "/entity/*{.js,.ts}"],
            enabledDrivers: ["mssql"],
        })
        for (const dataSource of dataSources) {
            await dataSource.query(`
                IF TYPE_ID('dbo.TvpIdList') IS NULL
                    CREATE TYPE dbo.TvpIdList AS TABLE (Id int NOT NULL PRIMARY KEY)`)
            await dataSource.query(`
                IF TYPE_ID('dbo.TvpIdName') IS NULL
                    CREATE TYPE dbo.TvpIdName AS TABLE (
                        Id int NOT NULL,
                        Name nvarchar(50) NULL
                    )`)
            await dataSource.query(
                `IF SCHEMA_ID('tvp_test') IS NULL EXEC('CREATE SCHEMA tvp_test')`,
            )
            await dataSource.query(`
                IF TYPE_ID('tvp_test.IdList') IS NULL
                    CREATE TYPE tvp_test.IdList AS TABLE (Id int NOT NULL PRIMARY KEY)`)
        }
    })

    beforeEach(async () => {
        await reloadTestingDatabases(dataSources)
        for (const dataSource of dataSources) {
            const postRepository = dataSource.getRepository(Post)
            for (let id = 1; id <= 5; id++) {
                await postRepository.save(
                    postRepository.create({
                        id,
                        name: `Post #${id}`,
                        category: "posts",
                        text: `Text #${id}`,
                    }),
                )
            }
        }
    })

    after(async () => {
        for (const dataSource of dataSources) {
            await dataSource.query("DROP TYPE IF EXISTS tvp_test.IdList")
            await dataSource.query("DROP SCHEMA IF EXISTS tvp_test")
            await dataSource.query("DROP TYPE IF EXISTS dbo.TvpIdName")
            await dataSource.query("DROP TYPE IF EXISTS dbo.TvpIdList")
        }
        await closeTestingConnections(dataSources)
    })

    const idList = (typeName: string, ids: number[]) =>
        new MssqlParameter(
            {
                typeName,
                columns: [{ name: "Id", type: "int", nullable: false }],
                rows: ids.map((id) => [id]),
            },
            "tvp",
        )

    it("should select rows with a table valued parameter in a raw query", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const rows: { id: number }[] = await dataSource.query(
                    `SELECT p.id FROM post p
                       JOIN @0 AS ids ON ids.Id = p.id
                      ORDER BY p.id`,
                    [idList("dbo.TvpIdList", [2, 4, 5])],
                )

                expect(rows.map((row) => row.id)).to.deep.equal([2, 4, 5])
            }),
        ))

    it("should select rows with a table valued parameter in the query builder", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const rows = await dataSource
                    .createQueryBuilder()
                    .select("post.id", "id")
                    .from(Post, "post")
                    .innerJoin(
                        "(SELECT Id FROM :ids)",
                        "ids",
                        "ids.Id = post.id",
                    )
                    .setParameter("ids", idList("dbo.TvpIdList", [1, 3]))
                    .orderBy("post.id")
                    .getRawMany<{ id: number }>()

                expect(rows.map((row) => row.id)).to.deep.equal([1, 3])
            }),
        ))

    it("should return no rows for a table valued parameter without rows", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const rows = await dataSource.query(
                    `SELECT p.id FROM post p JOIN @0 AS ids ON ids.Id = p.id`,
                    [idList("dbo.TvpIdList", [])],
                )

                expect(rows).to.have.length(0)
            }),
        ))

    it("should send more values than the bind parameter limit allows", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                // SQL Server allows about 2100 bind parameters in one request.
                const ids = Array.from(
                    { length: 5000 },
                    (_, index) => index + 1,
                )

                const rows: { count: number }[] = await dataSource.query(
                    `SELECT COUNT(*) AS count FROM post p
                       JOIN @0 AS ids ON ids.Id = p.id`,
                    [idList("dbo.TvpIdList", ids)],
                )

                expect(rows[0].count).to.equal(5)
            }),
        ))

    it("should send columns of more than one type", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const rows: { id: number; label: string | null }[] =
                    await dataSource.query(
                        `SELECT p.id, ids.Name AS label FROM post p
                           JOIN @0 AS ids ON ids.Id = p.id
                          ORDER BY p.id`,
                        [
                            new MssqlParameter(
                                {
                                    typeName: "dbo.TvpIdName",
                                    columns: [
                                        {
                                            name: "Id",
                                            type: "int",
                                            nullable: false,
                                        },
                                        {
                                            name: "Name",
                                            type: "nvarchar",
                                            params: [50],
                                        },
                                    ],
                                    rows: [
                                        [1, "one"],
                                        [2, null],
                                    ],
                                },
                                "tvp",
                            ),
                        ],
                    )

                expect(rows).to.deep.equal([
                    { id: 1, label: "one" },
                    { id: 2, label: null },
                ])
            }),
        ))

    it("should accept a table that the user builds with the mssql package", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const { mssql } = dataSource.driver as SqlServerDriver
                const table = new mssql.Table("dbo.TvpIdList")
                table.columns.add("Id", mssql.Int, { nullable: false })
                table.rows.add(3)
                table.rows.add(4)

                const rows: { id: number }[] = await dataSource.query(
                    `SELECT p.id FROM post p
                       JOIN @0 AS ids ON ids.Id = p.id
                      ORDER BY p.id`,
                    [new MssqlParameter(table, "tvp")],
                )

                expect(rows.map((row) => row.id)).to.deep.equal([3, 4])
            }),
        ))

    it("should use a table type in a schema other than dbo", () =>
        Promise.all(
            dataSources.map(async (dataSource) => {
                const rows: { id: number }[] = await dataSource.query(
                    `SELECT p.id FROM post p
                       JOIN @0 AS ids ON ids.Id = p.id
                      ORDER BY p.id`,
                    [idList("tvp_test.IdList", [1, 2])],
                )

                expect(rows.map((row) => row.id)).to.deep.equal([1, 2])
            }),
        ))
})
