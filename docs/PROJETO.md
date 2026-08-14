# Documentacao do Projeto Valtron

## Visao geral

Valtron e uma ferramenta desktop de analise local de dados tabulares: um mini data studio baseado em DuckDB para importar, consultar, editar, validar e explorar arquivos Excel/CSV sem depender de nuvem. O app roda com Tauri 2, usa Vite e TypeScript no frontend, e Rust no backend.

O foco atual do produto e abrir arquivos `.xlsx`, `.xlsm` e `.csv`, persistir cada importacao como um documento independente dentro de um workspace e permitir consulta, navegacao virtualizada, ordenacao, filtros por coluna, analise de campos vazios, edicao pontual de dados, exportacao e consultas SQL somente leitura.

O produto foi desenhado para ingerir arquivos gigantescos em poucos segundos, usando DuckDB como motor analitico local e mantendo a navegacao responsiva com grade virtualizada e consultas sob demanda.

## Principais capacidades

- Importacao de arquivos XLSX, XLSM e CSV pelo seletor nativo do sistema.
- Ingestao rapida de arquivos tabulares gigantescos em DuckDB local.
- Persistencia local em DuckDB no diretorio de dados do aplicativo.
- Organizacao de documentos por workspaces.
- Criacao e renomeacao de workspaces.
- Registro de multiplos documentos importados.
- Selecao, renomeacao, detalhamento, exportacao e exclusao de documentos ja importados.
- Grid virtualizada com carregamento em lotes de 100 linhas.
- Ordenacao por coluna em ciclo ascendente, descendente e sem ordenacao.
- Filtros textuais por coluna com debounce.
- Configuracao de colunas visiveis por documento.
- Larguras de colunas persistidas no navegador por documento ou consulta SQL.
- Redimensionamento manual e ajuste automatico de largura por duplo clique.
- Navegacao de celulas por teclado.
- Edicao de celulas em documentos importados, com validacao de tipo no backend.
- Renomeacao de colunas importadas.
- Estatisticas de linhas, colunas, filtros, celulas vazias e colunas com vazios.
- Painel de qualidade mostrando incidencia de vazio por coluna.
- Console SQL para consultas de leitura.
- Exportacao de documentos para CSV, TSV ou XLSX.
- Verificacao, download e instalacao de atualizacoes em builds de producao.

## Stack tecnica

- `Tauri 2`: empacotamento desktop e ponte entre frontend e Rust.
- `Vite`: servidor de desenvolvimento e build do frontend.
- `TypeScript`: interface e chamadas para comandos Tauri.
- `Rust`: importacao, persistencia, consultas e regras de seguranca.
- `DuckDB`: banco local analitico embutido.
- `calamine`: mantido para estrategias experimentais/legadas de leitura XLSX/XLSM.
- `@tauri-apps/plugin-dialog`: seletor nativo de arquivos.
- `@tauri-apps/plugin-updater`: verificacao e instalacao de atualizacoes.
- `@tauri-apps/plugin-process`: relancamento do app apos instalacao de atualizacao.

## Estrutura de arquivos

```text
.
|-- README.md
|-- package.json
|-- vite.config.ts
|-- tsconfig.json
|-- index.html
|-- src/
|   |-- services/
|   |   `-- updater/
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
- `workspaces`: lista de workspaces e contagem de documentos.
- `currentWorkspaceId`: workspace selecionado.
- `currentDocumentId`: documento selecionado.
- `currentPage`: janela/lote atual da grid.
- `sortColumn` e `sortDirection`: ordenacao ativa.
- `filterValues`: filtros por coluna.
- `columnPreferences`: larguras persistidas das colunas no `localStorage`.
- `dataMode`: alterna entre visualizacao de documento e resultado SQL.
- `currentSqlQuery`: consulta SQL ativa.
- `selectedCell` e `activeCellEdit`: selecao e edicao de celulas.

Componentes visuais principais:

- Topbar com botao de importacao.
- Modal de atualizacao.
- Area de status do arquivo.
- Seletor e formulario de workspaces.
- Lista de documentos importados.
- Menus e modais de detalhe, renomeacao, exportacao e exclusao de documentos.
- Console SQL recolhivel.
- Cards de estatisticas.
- Painel de qualidade de dados.
- Configurador de colunas visiveis.
- Grid tabular virtualizada.
- Editor inline de celulas.

Preferencias de interface guardadas localmente:

- `valtron.columnVisibility.v1.<document_id>`: colunas ocultas por documento.
- `valtron.columnWidths.v1.document.<document_id>`: larguras por documento.
- `valtron.columnWidths.v1.sql.<query>`: larguras por consulta SQL.

## Backend Rust

O backend principal fica em `src-tauri/src/lib.rs`. O arquivo `src-tauri/src/main.rs` apenas chama `valtron_lib::run()`.

Responsabilidades do backend:

- Resolver o caminho local do banco DuckDB.
- Inicializar a tabela de metadados `imported_documents`.
- Inicializar a tabela `workspaces` e migrar documentos antigos para o workspace padrao.
- Importar XLSX/XLSM no caminho padrao usando `read_xlsx` do DuckDB.
- Importar CSV usando `read_csv_auto` do DuckDB.
- Criar uma tabela propria para cada arquivo importado.
- Listar, criar e renomear workspaces.
- Listar, consultar, renomear, exportar e deletar documentos.
- Renomear colunas de documentos.
- Atualizar celulas de documentos por `rowid`.
- Montar paginas e janelas virtualizadas com filtros, ordenacao, estatisticas e metricas de performance.
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
- `workspace_id`: workspace ao qual o documento pertence.
- `file_name`: nome do arquivo importado.
- `sheet_name`: nome da primeira planilha ou `CSV`.
- `table_name`: tabela fisica com os dados importados.
- `row_count`: total de linhas importadas.
- `column_count`: total de colunas.
- `imported_at`: timestamp em milissegundos.
- `import_duration_ms`: duracao total da importacao, quando disponivel.
- `import_performance_json`: snapshot JSON das metricas de importacao, quando disponivel.

A tabela de workspaces e:

```sql
workspaces
```

Campos:

- `id`: identificador do workspace.
- `name`: nome exibido na interface.
- `created_at`: timestamp em milissegundos.

O workspace padrao usa o ID `default`. Documentos de bancos antigos sao associados automaticamente a ele na inicializacao.

Cada importacao cria uma tabela propria:

- XLSX/XLSM: `xlsx_rows_doc_<timestamp>`
- CSV: `csv_rows_doc_<timestamp>`

Todas as colunas sao armazenadas como texto para preservar a visualizacao simples e evitar inferencias inesperadas de tipo.

## Fluxo de importacao

1. O usuario clica em `Importar XLSX ou CSV`.
2. O plugin de dialogo do Tauri abre o seletor nativo.
3. O frontend envia o caminho do arquivo para o comando `import_document`.
4. O frontend tambem envia o workspace selecionado.
5. O Rust valida o workspace e identifica a extensao.
6. Para CSV, o DuckDB executa `read_csv_auto` com `all_varchar = true`, `ignore_errors = true` e `null_padding = true`.
7. Para XLSX/XLSM no caminho padrao, o DuckDB executa `read_xlsx` com `header = true` e `all_varchar = true`.
8. O backend consulta as colunas e a contagem final no DuckDB.
9. O documento e registrado em `imported_documents` com o workspace e as metricas disponiveis.
10. O frontend recarrega a lista de documentos e exibe a primeira janela da grid.

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

### `list_workspaces()`

Lista workspaces, trazendo a contagem de documentos de cada um. O workspace padrao aparece primeiro.

### `create_workspace(name)`

Cria um workspace com nome obrigatorio.

### `update_workspace(workspace_id, name)`

Renomeia um workspace existente.

### `import_document(path, workspace_id)`

Importa um arquivo `.xlsx`, `.xlsm` ou `.csv` e retorna um resumo da importacao.

Retorno:

- `document_id`
- `file_name`
- `sheet_name`
- `columns`
- `row_count`
- `imported_at`
- `import_duration_ms`
- `import_performance`

### `list_documents(workspace_id)`

Lista documentos importados do workspace informado, ordenados por `imported_at` decrescente.

### `delete_document(document_id)`

Remove a tabela de dados do documento e exclui o registro em `imported_documents`.

### `rename_document(document_id, name)`

Atualiza o nome exibido do documento em `imported_documents`.

### `rename_document_column(document_id, column_index, new_column)`

Renomeia uma coluna fisica da tabela importada com `ALTER TABLE ... RENAME COLUMN`. O backend rejeita nomes vazios, indice inexistente e nomes duplicados.

### `update_document_cell(document_id, row_id, column, value)`

Atualiza uma celula em documento importado usando o `rowid` interno do DuckDB. A edicao nao e habilitada para resultados SQL. O backend rejeita coluna inexistente, coluna interna e valor incompatavel com o tipo DuckDB da coluna.

### `export_document(document_id, path, format)`

Exporta o documento completo para `csv`, `tsv` ou `xlsx`.

- CSV e TSV usam `COPY (SELECT * FROM tabela) TO ... (HEADER, DELIMITER ...)`.
- XLSX e gerado como um pacote XLSX simples com uma planilha chamada `Dados`.
- O arquivo de destino e substituido se ja existir.

### `get_table_page(document_id, offset, limit, filters, sort_column, sort_direction)`

Retorna uma pagina de dados de um documento importado, com filtros, ordenacao e estatisticas.

O limite e normalizado entre 25 e 500 linhas. O frontend usa 100.

Este comando permanece disponivel, mas a interface principal usa `get_table_window` para a grade virtualizada.

### `get_table_window(document_id, offset, limit, filters, sort_column, sort_direction, visible_columns)`

Retorna uma janela de linhas para a grade virtualizada.

Inclui:

- `columns`: todas as colunas da fonte.
- `column_types`: tipos DuckDB das colunas do documento.
- `rows`: valores apenas das colunas visiveis solicitadas.
- `row_ids`: `rowid` interno do DuckDB para permitir edicao de celulas.
- `has_more` e `next_offset`: informacoes para prefetch.
- `performance`: tempos de consulta DuckDB, processamento Rust e total.

### `get_sql_page(query, offset, limit, filters, sort_column, sort_direction)`

Executa uma consulta SQL de leitura e retorna uma pagina tabular do resultado.

Consultas permitidas:

- `SELECT`
- `WITH`
- `SHOW`
- `DESCRIBE`
- `EXPLAIN`

O backend bloqueia consultas vazias, multiplas instrucoes separadas por `;` e comandos fora da lista permitida.

### `get_sql_window(query, offset, limit, filters, sort_column, sort_direction, visible_columns)`

Equivalente virtualizado de `get_sql_page`. Retorna uma janela da consulta SQL com filtros, ordenacao, estatisticas e metricas, mas sem `row_ids` editaveis.

## Workspaces

Workspaces agrupam documentos importados sem mover as tabelas fisicas do DuckDB. A selecao ativa filtra a lista lateral e define onde novas importacoes serao registradas.

Regras atuais:

- O workspace padrao sempre existe.
- Documentos sem `workspace_id` sao migrados para o workspace padrao.
- Workspaces podem ser criados e renomeados.
- A exclusao de workspace ainda nao existe.

## Grade virtualizada

A interface principal usa uma grade virtualizada em vez de renderizar a pagina inteira como uma tabela HTML tradicional. O frontend calcula a faixa visivel pelo `scrollTop`, usa altura fixa de linha e carrega lotes de 100 linhas com overscan.

Parametros principais:

- `GRID_BATCH_SIZE`: 100 linhas.
- `GRID_ROW_HEIGHT`: 42 px.
- `GRID_OVERSCAN_ROWS`: 8 linhas.
- `GRID_PREFETCH_RATIO`: 0,75.
- `GRID_MAX_CACHED_BATCHES`: 5 lotes.

O backend retorna apenas a janela solicitada. O frontend mantem cache dos lotes proximos, descarta lotes distantes e registra metricas `GRID_PERFORMANCE` no console.

## Configuracao de colunas

A grade permite ocultar colunas em documentos importados e preservar largura por grade.

Comportamento:

- A configuracao de visibilidade vale apenas para documentos, nao para resultados SQL.
- Pelo menos uma coluna precisa permanecer visivel.
- Ao ocultar uma coluna com filtro ou ordenacao ativos, o frontend remove esse filtro/ordenacao e recarrega a grade.
- As larguras sao inferidas inicialmente pelo nome da coluna e depois podem ser redimensionadas.
- O duplo clique no divisor ajusta a largura com base no cabecalho e em amostras carregadas.
- Preferencias de largura sao guardadas no `localStorage` por documento ou por consulta SQL.

## Edicao de dados

Celulas de documentos importados podem ser editadas diretamente na grade. Resultados SQL nao sao editaveis.

Fluxo:

1. O frontend seleciona a celula e inicia a edicao inline.
2. A alteracao e aplicada otimisticamente ao cache local.
3. O backend executa `UPDATE tabela SET coluna = ? WHERE rowid = ?`.
4. Em sucesso, a celula fica marcada temporariamente como atualizada.
5. Em erro, o cache local volta ao valor original e a mensagem do backend e exibida.

O backend valida:

- `row_id` nao negativo.
- coluna existente e diferente da coluna interna `_valtron_row_id`.
- compatibilidade do valor com o tipo DuckDB da coluna usando `TRY_CAST` para tipos nao textuais.

## Exportacao

A exportacao sempre usa o documento completo, independentemente de filtros, ordenacao ou colunas ocultas da grade.

Formatos:

- `csv`: delimitador virgula.
- `tsv`: delimitador tab.
- `xlsx`: arquivo XLSX simples com strings inline, cabecalho na primeira linha e planilha `Dados`.

## Atualizacoes automaticas

O servico `src/services/updater/updater.service.ts` integra:

- `getVersion` para exibir a versao instalada.
- `check` do plugin updater para verificar releases.
- `downloadAndInstall` com callback de progresso.
- `relaunch` do plugin process para reiniciar apos a instalacao.

O updater so e habilitado quando o app esta em Tauri e em modo de producao. Em desenvolvimento ou fora do Tauri, a checagem retorna a versao atual sem oferecer instalacao.

O endpoint configurado em `src-tauri/tauri.conf.json` aponta para:

```text
https://github.com/Zigtecnologia-web/valtron/releases/latest/download/latest.json
```

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

Paginacao e virtualizacao:

- `limit` minimo: 25.
- `limit` maximo: 500.
- `offset` e mantido conforme solicitado.
- A grade principal solicita janelas de 100 linhas e prefetch conforme a posicao do scroll.

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

Existem testes Rust em `src-tauri/src/lib.rs` validando caminhos auxiliares de ingestao com DuckDB, incluindo CSV irregular como texto, copia de CSV em schema textual conhecido e ingestao Arrow como texto.

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
- A exportacao usa o documento completo e ainda nao respeita filtros, ordenacao ou colunas ocultas.
- A edicao de celulas depende de `rowid` do DuckDB e nao se aplica a resultados SQL.
- Preferencias de colunas ficam no `localStorage`, portanto sao locais ao navegador/webview.

## Pontos de evolucao sugeridos

- Permitir escolher qual planilha importar em arquivos XLSX/XLSM.
- Adicionar suporte a remocao em lote de documentos.
- Adicionar exclusao de workspaces e movimentacao de documentos entre workspaces.
- Criar testes para `validate_read_query`, filtros, ordenacao e normalizacao de cabecalhos.
- Separar o frontend em modulos ou componentes.
- Cachear estatisticas de qualidade por documento quando nao houver filtros.
- Exibir progresso incremental durante importacoes grandes.
- Permitir exportar resultados filtrados, ordenados ou com subconjunto de colunas.
