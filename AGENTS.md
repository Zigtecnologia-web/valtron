# Regras de manutencao do projeto

## Importacao XLSX protegida

Nao alterar o fluxo de importacao XLSX/XLSM sem pedido explicito do usuario.

O caminho padrao protegido e:

```text
strategy = xlsx_direct
DuckDB read_xlsx
CREATE TABLE ... AS SELECT * FROM read_xlsx(...)
header = true
all_varchar = true
```

Esse fluxo existe para evitar leitura duplicada do XLSX pela aplicacao Rust antes do DuckDB. No modo `xlsx_direct`, nao usar `calamine::open_workbook`, `worksheet_cells_reader`, CSV intermediario, Arrow, batches, appender ou insercao linha a linha como caminho principal.

E permitido manter estrategias experimentais selecionadas explicitamente por variavel de ambiente, mas nenhuma delas deve substituir `xlsx_direct` como padrao sem benchmark real e pedido claro do usuario.

Antes de qualquer alteracao nessa area, preservar estes invariantes:

- primeira planilha importada;
- primeira linha usada como cabecalho;
- todas as colunas como texto para preservar zeros a esquerda, CPF/CNPJ, codigos e matriculas;
- documento so registrado em `imported_documents` apos importacao e contagem final;
- metricas de performance sem duplicar tempos entre mecanismos diferentes;
- `xlsx_open_ms` e `worksheets_read_ms` devem permanecer proximos de zero no caminho `xlsx_direct`.

Qualquer nova funcionalidade que nao seja especificamente sobre performance/importacao XLSX deve tratar essa area como fora de escopo.
