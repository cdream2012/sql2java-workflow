/**
 * schema-fetcher.test.ts — DB Schema 发现测试（PostgreSQL / GaussDB）
 *
 * 配置解析部分（parsePgJdbcUrl / loadDbConfig）是纯函数/文件 IO，无需真实 DB，已落地。
 * 连接/查询/DDL 生成部分需 mock pg.Client 或真实 PG/GaussDB 实例，保持 it.todo。
 *
 * SUT 通过 @workflow 别名访问。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadDbConfig,
  parsePgJdbcUrl,
  cleanupGeneratedDdl,
} from "@workflow/schema-fetcher"
import { GENERATED_OUTPUT_DIR, GENERATED_MARKER, GENERATED_MARKER_ID } from "@workflow/constants"

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sql2java-sf-"))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe("parsePgJdbcUrl", () => {
  it("解析标准 PostgreSQL URL", () => {
    const r = parsePgJdbcUrl("jdbc:postgresql://localhost:5432/my_database")
    expect(r).toEqual({ host: "localhost", port: 5432, database: "my_database", sslmode: undefined })
  })

  it("缺省端口默认 5432", () => {
    const r = parsePgJdbcUrl("jdbc:postgresql://db-host/erp_db")
    expect(r.host).toBe("db-host")
    expect(r.port).toBe(5432)
    expect(r.database).toBe("erp_db")
  })

  it("支持 GaussDB opengauss 前缀", () => {
    const r = parsePgJdbcUrl("jdbc:opengauss://db-host:5432/erp_db")
    expect(r.host).toBe("db-host")
    expect(r.database).toBe("erp_db")
  })

  it("支持 gaussdb 前缀", () => {
    const r = parsePgJdbcUrl("jdbc:gaussdb://db-host:5432/erp_db")
    expect(r.database).toBe("erp_db")
  })

  it("解析 sslmode 查询参数", () => {
    const r = parsePgJdbcUrl("jdbc:postgresql://db-host:5432/erp_db?sslmode=require")
    expect(r.sslmode).toBe("require")
    expect(r.database).toBe("erp_db")
  })

  it("无效前缀抛错", () => {
    expect(() => parsePgJdbcUrl("jdbc:oracle:thin:@host:1521/db")).toThrow(/jdbc:postgresql|jdbc:opengauss|jdbc:gaussdb/)
  })

  it("缺少数据库名抛错", () => {
    expect(() => parsePgJdbcUrl("jdbc:postgresql://db-host:5432/")).toThrow(/数据库名/)
  })
})

describe("loadDbConfig", () => {
  it("解析 db.properties 核心字段", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, [
      "# 注释行",
      "db.driver=org.postgresql.Driver",
      "db.url=jdbc:postgresql://localhost:5432/my_database",
      "db.username=postgres",
      "db.password=secret_password",
      "db.connectTimeout=10",
      "db.socketTimeout=30",
      "",
    ].join("\n"), "utf-8")

    const cfg = loadDbConfig(confPath)!
    expect(cfg.host).toBe("localhost")
    expect(cfg.port).toBe(5432)
    expect(cfg.database).toBe("my_database")
    expect(cfg.user).toBe("postgres")
    expect(cfg.password).toBe("secret_password")
    expect(cfg.schema).toBe("public")
    expect(cfg.connectionTimeoutMillis).toBe(10_000)
    expect(cfg.statementTimeoutMillis).toBe(30_000)
  })

  it("db.user 作为 username 别名", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, [
      "db.url=jdbc:postgresql://h:5432/db",
      "db.user=alice",
      "db.password=pw",
    ].join("\n"), "utf-8")
    expect(loadDbConfig(confPath)!.user).toBe("alice")
  })

  it("db.schema 自定义覆盖默认 public", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, [
      "db.url=jdbc:postgresql://h:5432/db",
      "db.username=u",
      "db.password=p",
      "db.schema=erp_owner",
    ].join("\n"), "utf-8")
    expect(loadDbConfig(confPath)!.schema).toBe("erp_owner")
  })

  it("名称过滤与拉取开关解析", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, [
      "db.url=jdbc:postgresql://h:5432/db",
      "db.username=u",
      "db.password=p",
      "db.tableFilter=t_%",
      "db.fetchViews=false",
      "db.fetchObjectTypes=false",
    ].join("\n"), "utf-8")
    const cfg = loadDbConfig(confPath)!
    expect(cfg.tableFilter).toBe("t_%")
    expect(cfg.fetchViews).toBe(false)
    expect(cfg.fetchObjectTypes).toBe(false)
    expect(cfg.fetchTables).toBe(true) // 默认 true
  })

  it("sslmode=require 推导 ssl=true", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, [
      "db.url=jdbc:postgresql://h:5432/db?sslmode=require",
      "db.username=u",
      "db.password=p",
    ].join("\n"), "utf-8")
    expect(loadDbConfig(confPath)!.ssl).toBe(true)
  })

  it("sslmode=disable 推导 ssl=false", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, [
      "db.url=jdbc:postgresql://h:5432/db?sslmode=disable",
      "db.username=u",
      "db.password=p",
    ].join("\n"), "utf-8")
    expect(loadDbConfig(confPath)!.ssl).toBe(false)
  })

  it("env:VAR 密码在 loadDbConfig 阶段保持原样（运行时解析）", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, [
      "db.url=jdbc:postgresql://h:5432/db",
      "db.username=u",
      "db.password=env:PG_PASSWORD",
    ].join("\n"), "utf-8")
    expect(loadDbConfig(confPath)!.password).toBe("env:PG_PASSWORD")
  })

  it("缺少 db.url 抛错", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, "db.username=u\ndb.password=p\n", "utf-8")
    expect(() => loadDbConfig(confPath)).toThrow(/db.url/)
  })

  it("缺少 db.username 抛错", () => {
    const confPath = join(workDir, "db.properties")
    writeFileSync(confPath, "db.url=jdbc:postgresql://h:5432/db\ndb.password=p\n", "utf-8")
    expect(() => loadDbConfig(confPath)).toThrow(/db.username/)
  })

  it("自动发现 sourcePath/db.properties", () => {
    writeFileSync(join(workDir, "db.properties"), [
      "db.url=jdbc:postgresql://h:5432/db",
      "db.username=u",
      "db.password=p",
    ].join("\n"), "utf-8")
    const cfg = loadDbConfig(undefined, workDir)!
    expect(cfg.database).toBe("db")
  })

  it("无配置文件返回 null（DDL-only 模式）", () => {
    expect(loadDbConfig(undefined, workDir)).toBeNull()
  })

  it("显式指定路径不存在抛错", () => {
    expect(() => loadDbConfig(join(workDir, "nope.properties"))).toThrow(/不存在/)
  })
})

describe("cleanupGeneratedDdl", () => {
  it("清理带本工具标记的 ddl-output 目录", () => {
    const outDir = join(workDir, GENERATED_OUTPUT_DIR)
    const schemaDir = join(outDir, "schema")
    mkdirSync(schemaDir, { recursive: true })
    writeFileSync(join(schemaDir, "t.sql"), "create table t (id int);", "utf-8")
    writeFileSync(
      join(outDir, GENERATED_MARKER),
      JSON.stringify({ generator: GENERATED_MARKER_ID, createdAt: "2026-06-23T00:00:00.000Z" }),
      "utf-8",
    )
    expect(existsSync(outDir)).toBe(true)
    cleanupGeneratedDdl(workDir)
    expect(existsSync(outDir)).toBe(false)
  })

  it("不删除无标记的用户自有同名目录", () => {
    const outDir = join(workDir, GENERATED_OUTPUT_DIR)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, "user.sql"), "select 1;", "utf-8")
    // 无 .sql2java-generated 标记
    cleanupGeneratedDdl(workDir)
    expect(existsSync(outDir)).toBe(true)
    expect(readdirSync(outDir)).toContain("user.sql")
  })

  it("目录不存在时安全返回", () => {
    expect(() => cleanupGeneratedDdl(workDir)).not.toThrow()
  })
})

describe("fetchSchemaIfNeeded", () => {
  it.todo("无 db.properties 时跳过 (fetched=false)")
  it.todo("pg 未安装时优雅降级返回 error")
  it.todo("连接失败时返回 PG 语义错误并清理 ddl-output")
  // mock pg.Client 的 query 方法返回预定义 catalog 数据，验证 tablesFetched 等计数
  it.todo("成功连接后返回各对象计数")
})

describe("DDL 生成", () => {
  // mock pg.Client 返回 information_schema.columns + pg_constraint 数据，验证生成的 .sql 内容
  it.todo("表 DDL 包含列与 PG 约束定义")
  it.todo("列注释用 COMMENT ON COLUMN 语法")
  it.todo("序列 DDL 使用 PG 语法")
  it.todo("枚举/复合/域类型 DDL 正确重建")
})

describe("文件路径去重", () => {
  // TABLE_A 视图与 table_a 表小写化后冲突
  it.todo("大小写冲突检测追加 _2 后缀")
})
