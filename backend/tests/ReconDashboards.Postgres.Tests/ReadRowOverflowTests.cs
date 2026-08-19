using System.Collections;
using System.Data.Common;

namespace ReconDashboards.Postgres.Tests;

/// <summary>
/// The executor's per-cell overflow guard, pinned against a stub reader so it
/// runs without Docker. <see cref="NumericOverflowExecutionTests"/> proves the
/// same behavior end-to-end against a real server (and is what verifies the
/// ASSUMPTION that Npgsql throws here at all); these pin the fallback logic
/// itself — which value survives, and what a second failure degrades to.
/// </summary>
public sealed class ReadRowOverflowTests
{
    [Fact]
    public void A_value_too_wide_for_decimal_is_re_read_as_a_double()
    {
        var row = PostgresQueryExecutor.ReadRow(new StubReader([StubCell.Overflowing(1e40)]));

        Assert.Equal(1e40, Assert.IsType<double>(row[0]));
    }

    /// <summary>NaN / +-Infinity numerics surface as InvalidCastException, not OverflowException.</summary>
    [Fact]
    public void A_value_decimal_cannot_express_is_re_read_as_a_double()
    {
        var row = PostgresQueryExecutor.ReadRow(new StubReader([StubCell.Unrepresentable(12.5)]));

        Assert.Equal(12.5, Assert.IsType<double>(row[0]));
    }

    [Fact]
    public void A_non_finite_fallback_degrades_to_null()
    {
        var row = PostgresQueryExecutor.ReadRow(
            new StubReader([StubCell.Overflowing(double.NaN), StubCell.Overflowing(double.PositiveInfinity)]));

        Assert.Null(row[0]);
        Assert.Null(row[1]);
    }

    [Fact]
    public void A_fallback_that_also_fails_degrades_to_null_rather_than_throwing()
    {
        var row = PostgresQueryExecutor.ReadRow(new StubReader([StubCell.Unreadable()]));

        Assert.Null(row[0]);
    }

    [Fact]
    public void One_bad_cell_never_costs_the_rest_of_the_row()
    {
        var row = PostgresQueryExecutor.ReadRow(new StubReader(
        [
            StubCell.Plain(7),
            StubCell.Overflowing(1e40),
            StubCell.Plain("label"),
            StubCell.Plain(DBNull.Value),
        ]));

        Assert.Equal(7, row[0]);
        Assert.IsType<double>(row[1]);
        Assert.Equal("label", row[2]);
        Assert.Null(row[3]);
    }

    [Fact]
    public void Ordinary_values_are_untouched()
    {
        var row = PostgresQueryExecutor.ReadRow(new StubReader([StubCell.Plain(123.456m)]));

        Assert.Equal(123.456m, Assert.IsType<decimal>(row[0]));
    }

    /// <summary>How one column behaves: its GetValue result, or the failure it raises plus what a double re-read yields.</summary>
    private sealed record StubCell(object? Value, Exception? GetValueError, double? Wide, Exception? WideError)
    {
        public static StubCell Plain(object? value) => new(value, null, null, null);

        public static StubCell Overflowing(double wide) => new(null, new OverflowException(), wide, null);

        public static StubCell Unrepresentable(double wide) => new(null, new InvalidCastException(), wide, null);

        public static StubCell Unreadable() => new(null, new OverflowException(), null, new InvalidCastException());
    }

    /// <summary>Only the members ReadRow touches do anything; the rest are unreachable by design.</summary>
    private sealed class StubReader(IReadOnlyList<StubCell> cells) : DbDataReader
    {
        public override int FieldCount => cells.Count;

        public override object GetValue(int ordinal) =>
            cells[ordinal].GetValueError is { } error ? throw error : cells[ordinal].Value ?? DBNull.Value;

        public override T GetFieldValue<T>(int ordinal)
        {
            var cell = cells[ordinal];
            if (cell.WideError is { } error)
            {
                throw error;
            }

            return (T)(object)cell.Wide!.Value;
        }

        public override int Depth => throw new NotSupportedException();
        public override bool HasRows => throw new NotSupportedException();
        public override bool IsClosed => throw new NotSupportedException();
        public override int RecordsAffected => throw new NotSupportedException();
        public override object this[int ordinal] => throw new NotSupportedException();
        public override object this[string name] => throw new NotSupportedException();
        public override bool GetBoolean(int ordinal) => throw new NotSupportedException();
        public override byte GetByte(int ordinal) => throw new NotSupportedException();
        public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length) =>
            throw new NotSupportedException();
        public override char GetChar(int ordinal) => throw new NotSupportedException();
        public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length) =>
            throw new NotSupportedException();
        public override string GetDataTypeName(int ordinal) => throw new NotSupportedException();
        public override DateTime GetDateTime(int ordinal) => throw new NotSupportedException();
        public override decimal GetDecimal(int ordinal) => throw new NotSupportedException();
        public override double GetDouble(int ordinal) => throw new NotSupportedException();
        public override Type GetFieldType(int ordinal) => throw new NotSupportedException();
        public override float GetFloat(int ordinal) => throw new NotSupportedException();
        public override Guid GetGuid(int ordinal) => throw new NotSupportedException();
        public override short GetInt16(int ordinal) => throw new NotSupportedException();
        public override int GetInt32(int ordinal) => throw new NotSupportedException();
        public override long GetInt64(int ordinal) => throw new NotSupportedException();
        public override string GetName(int ordinal) => throw new NotSupportedException();
        public override int GetOrdinal(string name) => throw new NotSupportedException();
        public override string GetString(int ordinal) => throw new NotSupportedException();
        public override int GetValues(object[] values) => throw new NotSupportedException();
        public override bool IsDBNull(int ordinal) => throw new NotSupportedException();
        public override bool NextResult() => throw new NotSupportedException();
        public override bool Read() => throw new NotSupportedException();
        public override IEnumerator GetEnumerator() => throw new NotSupportedException();
    }
}
