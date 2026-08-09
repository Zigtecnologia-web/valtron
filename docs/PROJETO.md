# Documentacao do Projeto Valtron

## Visao geral

Valtron e uma ferramenta desktop de analise local de dados tabulares: um mini data studio baseado em DuckDB para importar, consultar, validar e explorar arquivos Excel/CSV sem depender de nuvem. O app roda com Tauri 2, usa Vite e TypeScript no frontend, e Rust no backend.

O foco atual do produto e abrir arquivos `.xlsx`, `.xlsm` e `.csv`, persistir cada importacao como um documento independente e permitir consulta, paginacao, ordenacao, filtros por coluna, analise de campos vazios e consultas SQL somente leitura.

O produto foi desenhado para ingerir arquivos gigantescos em poucos segundos, usando DuckDB como motor analitico local e mantendo a navegacao responsiva com paginacao e consultas sob demanda.

## Principais capacidades

- Importacao de arquivos XLSX, XLSM e CSV pelo seletor nativo do sistema.
- Ingestao rapida de arquivos tabulares gigantescos em DuckDB local.
- Persistencia local em DuckDB no diretorio de dados do aplicativo.
- Registro de multiplos documentos importados.
- Selecao e exclusao de documentos ja importados.
- Grid com paginacao de 100 linhas por pagina.
- Ordenacao por coluna em ciclo ascendente, descendente e sem ordenacao.
- Filtros textuais por coluna com debounce.
- Estatisticas de linhas, colunas, filtros, celulas vazias e colunas com vazios.
- Painel de qualidade mostrando incidencia de vazio por coluna.
- Console SQL para consultas de leitura.

## Stack tecnica

- `Tauri 2`: empacotamento desktop e ponte entre frontend e Rust.
- `Vite`: servidor de desenvolvimento e build do frontend.
- `TypeScript`: interface e chamadas para comandos Tauri.
- `Rust`: importacao, persistencia, consultas e regras de seguranca.
- `DuckDB`: banco local analitico embutido.
- `calamine`: mantido para estrategias experimentais/legadas de leitura XLSX/XLSM.
- `@tauri-apps/plugin-dialog`: seletor nativo de arquivos.

## Estrutura de arquivos

```text
.
|-- README.md
|-- package.json
|-- vite.config.ts
|-- tsconfig.json
|-- index.html
|-- src/
|   |-- main.ts
|   `-- styles.css
|-- src-tauri/
|   |-- Cargo.toml
|   |-- tauri.conf.json
|   `-- src/
|       |-- lib.rs
|       `-- main.rs
`-- docs/
    `-- PROJETO.md
```

Os diretorios `dist/`, `node_modules/`, `src-tauri/target/` e `src-tauri/gen/` sao artefatos gerados ou dependencias locais e ficam fora do versionamento pelo `.gitignore`.

## Frontend

O frontend esta concentrado em `src/main.ts`. Ele monta a interface diretamente via `app.innerHTML`, registra eventos de usuario e chama os comandos Rust com `invoke`.

Estados principais mantidos no frontend:

- `documents`: lista de documentos registrados no DuckDB.
- `currentDocumentId`: documento selecionado.
- `currentPage`: pagina atual da grid.
- `sortColumn` e `sortDirection`: ordenacao ativa.
- `filterValues`: filtros por coluna.
- `dataMode`: alterna entre visualizacao de documento e resultado SQL.
- `currentSqlQuery`: consulta SQL ativa.

Componentes visuais principais:

- Topbar com botao de importacao.
- Area de status do arquivo.
- Lista de documentos importados.
- Console SQL recolhivel.
- Cards de estatisticas.
- Painel de qualidade de dados.
- Grid tabular paginada.

## Backend Rust

O backend principal fica em `src-tauri/src/lib.rs`. O arquivo `src-tauri/src/main.rs` apenas chama `valtron_lib::run()`.

Responsabilidades do backend:

- Resolver o caminho local do banco DuckDB.
- Inicializar a tabela de metadados `imported_documents`.
- Importar XLSX/XLSM no caminho padrao usando `read_xlsx` do DuckDB.
- Importar CSV usando `read_csv_auto` do DuckDB.
- Criar uma tabela propria para cada arquivo importado.
- Listar, consultar e deletar documentos.
- Montar paginas com filtros, ordenacao e estatisticas.
- Validar consultas SQL do console.

## Banco de dados local

O arquivo DuckDB e criado no diretorio de dados do app com o nome:

```text
valtron.duckdb
```

A tabela de metadados e:

```sql
imported_documents
```

Campos:

- `id`: identificador do documento, gerado com timestamp em milissegundos.
- `file_name`: nome do arquivo importado.
- `sheet_name`: nome da primeira planilha ou `CSV`.
- `table_name`: tabela fisica com os dados importados.
- `row_count`: total de linhas importadas.
- `column_count`: total de colunas.
- `imported_at`: timestamp em milissegundos.

Cada importacao cria uma tabela propria:

- XLSX/XLSM: `xlsx_rows_doc_<timestamp>`
- CSV: `csv_rows_doc_<timestamp>`

Todas as colunas sao armazenadas como texto para preservar a visualizacao simples e evitar inferencias inesperadas de tipo.

## Fluxo de importacao

1. O usuario clica em `Importar XLSX ou CSV`.
2. O plugin de dialogo do Tauri abre o seletor nativo.
3. O frontend envia o caminho do arquivo para o comando `import_document`.
4. O Rust identifica a extensao.
5. Para CSV, o DuckDB executa `read_csv_auto` com `all_varchar = true`, `ignore_errors = true` e `null_padding = true`.
6. Para XLSX/XLSM no caminho padrao, o DuckDB executa `read_xlsx` com `header = true` e `all_varchar = true`.
7. O backend consulta as colunas e a contagem final no DuckDB.
8. O documento e registrado em `imported_documents`.
9. O frontend recarrega a lista de documentos e exibe a primeira pagina.

## Importacao XLSX/XLSM

O importador aceita apenas `.xlsx` e `.xlsm`. Arquivos `.xls` e `.xlsb` nao sao suportados.

Detalhes importantes:

- Apenas a primeira planilha do arquivo e importada.
- A primeira linha da area detectada e usada como cabecalho.
- O limite de seguranca e `16.384` colunas.
- A estrategia padrao e `xlsx_direct`.
- `xlsx_direct` usa `CREATE TABLE ... AS SELECT * FROM read_xlsx(...)`.
- As opcoes padrao do `read_xlsx` sao `header = true` e `all_varchar = true`.
- O nome da primeira planilha e obtido de forma barata lendo apenas `xl/workbook.xml` dentro do ZIP XLSX.
- O caminho padrao nao deve abrir a planilha com `calamine`, nao deve percorrer celulas antes do DuckDB e nao deve gerar CSV intermediario.
- Estrategias experimentais/legadas podem ser ativadas por `VALTRON_XLSX_IMPORT_STRATEGY`, mas nao sao padrao.

Durante a importacao XLSX, o backend escreve metricas no stderr com o prefixo `IMPORT_PERFORMANCE`, incluindo `import_strategy`, metodo usado pelo DuckDB, opcoes do `read_xlsx`, tempos de pre-abertura, leitura de planilha, importacao XLSX do DuckDB e total.

### Regra protegida de manutencao

Esta area nao deve ser alterada em tarefas de novas funcionalidades, ajustes visuais, consultas, filtros, workspaces ou qualquer outro escopo que nao peca explicitamente mudancas na importacao XLSX.

O fluxo `xlsx_direct` foi protegido porque uma investigacao de performance mostrou que abrir o XLSX previamente em Rust adicionava cerca de `5s` antes de o DuckDB abrir/processar o mesmo arquivo novamente. O objetivo do caminho atual e evitar essa leitura duplicada:

```text
arquivo.xlsx
↓
DuckDB read_xlsx
↓
tabela
```

Nao reintroduzir no caminho padrao:

- `calamine::open_workbook` antes do DuckDB;
- `worksheet_cells_reader` antes do DuckDB;
- conversao XLSX para CSV;
- Arrow/batches como substituto automatico;
- `append_row` ou insercao linha a linha;
- qualquer pre-processamento que percorra celulas do XLSX.

Se for necessario experimentar outra estrategia, ela deve ficar atras de uma selecao explicita, por exemplo `VALTRON_XLSX_IMPORT_STRATEGY`, e so pode virar padrao com pedido claro do usuario e benchmark real melhor que o baseline.

Metricas esperadas no caminho protegido:

```text
strategy: xlsx_direct
duckdb_xlsx_method: read_xlsx_create_table_as
duckdb_xlsx_options: header=true, all_varchar=true
xlsx_open_ms: ~0
worksheets_read_ms: ~0
csv_generation_ms: 0
duckdb_copy_ms: 0
duckdb_appender_ms: 0
```

## Importacao CSV

CSV e importado diretamente pelo DuckDB:

```sql
read_csv_auto(
  caminho,
  header = true,
  all_varchar = true,
  ignore_errors = true,
  null_padding = true
)
```

Essa abordagem favorece robustez para arquivos irregulares, mantendo os valores como texto e preenchendo colunas ausentes quando possivel.

## Comandos Tauri

### `import_document(path)`

Importa um arquivo `.xlsx`, `.xlsm` ou `.csv` e retorna um resumo da importacao.

Retorno:

- `document_id`
- `file_name`
- `sheet_name`
- `columns`
- `row_count`
- `imported_at`

### `list_documents()`

Lista documentos importados, ordenados por `imported_at` decrescente.

### `delete_document(document_id)`

Remove a tabela de dados do documento e exclui o registro em `imported_documents`.

### `get_table_page(document_id, offset, limit, filters, sort_column, sort_direction)`

Retorna uma pagina de dados de um documento importado, com filtros, ordenacao e estatisticas.

O limite e normalizado entre 25 e 500 linhas. O frontend usa 100.

### `get_sql_page(query, offset, limit, filters, sort_column, sort_direction)`

Executa uma consulta SQL de leitura e retorna uma pagina tabular do resultado.

Consultas permitidas:

- `SELECT`
- `WITH`
- `SHOW`
- `DESCRIBE`
- `EXPLAIN`

O backend bloqueia consultas vazias, multiplas instrucoes separadas por `;` e comandos fora da lista permitida.

## Paginacao, filtros e ordenacao

A funcao central para leitura tabular e `get_page_from_source`. Ela recebe uma consulta fonte, aplica filtros, ordenacao e pagina a partir dela.

Filtros:

- Sao aplicados com `LOWER(COALESCE(coluna, '')) LIKE ?`.
- Valores vazios sao ignorados.
- Colunas inexistentes sao descartadas.

Ordenacao:

- So aceita colunas existentes no resultado.
- Usa `NULLIF(coluna, '')` para tratar strings vazias.
- Direcoes aceitas na pratica: `asc` e `desc`.

Paginacao:

- `limit` minimo: 25.
- `limit` maximo: 500.
- `offset` e mantido conforme solicitado.

## Estatisticas de qualidade

Para cada pagina carregada, o backend calcula estatisticas sobre a fonte inteira da consulta atual:

- Quantidade de colunas.
- Quantidade de colunas com pelo menos um valor vazio.
- Total de celulas vazias.
- Lista de colunas com contagem de vazios.

Um valor e considerado vazio quando e `NULL` ou quando `TRIM(CAST(valor AS VARCHAR)) = ''`.

## Como rodar

Instale dependencias:

```bash
npm install
```

Rode em desenvolvimento:

```bash
npm run tauri:dev
```

Rode apenas o frontend Vite:

```bash
npm run dev
```

Nesse modo a importacao nativa nao funciona, pois depende do ambiente Tauri.

## Build

Build do frontend:

```bash
npm run build
```

Build desktop Tauri:

```bash
npm run tauri:build
```

No macOS, o pacote `.app` e gerado em:

```text
src-tauri/target/release/bundle/macos/Valtron.app
```

## Testes

Existe um teste Rust em `src-tauri/src/lib.rs` validando a importacao de CSV irregular como texto via DuckDB.

Para rodar:

```bash
cd src-tauri
cargo test
```

## Limitacoes conhecidas

- A importacao XLSX/XLSM usa apenas a primeira planilha.
- Arquivos `.xls` e `.xlsb` nao sao aceitos.
- O console SQL permite apenas comandos de leitura por validacao simples do primeiro token.
- As estatisticas de vazios sao recalculadas por coluna, o que pode custar mais em tabelas muito largas ou consultas SQL complexas.
- IDs de documentos usam timestamp em milissegundos; importacoes simultaneas no mesmo milissegundo poderiam colidir.
- O frontend esta em um unico arquivo TypeScript, o que facilita o prototipo, mas pode dificultar manutencao se a interface crescer.

## Pontos de evolucao sugeridos

- Permitir escolher qual planilha importar em arquivos XLSX/XLSM.
- Adicionar suporte a remocao em lote de documentos.
- Criar testes para `validate_read_query`, filtros, ordenacao e normalizacao de cabecalhos.
- Separar o frontend em modulos ou componentes.
- Cachear estatisticas de qualidade por documento quando nao houver filtros.
- Exibir progresso incremental durante importacoes grandes.
- Adicionar exportacao dos resultados filtrados para CSV.
