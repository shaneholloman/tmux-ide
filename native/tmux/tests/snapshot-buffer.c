/* Bounded snapshot accumulator: no tmux server or application state required. */
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static int allocations, fail_allocation;
static size_t largest_allocation;
static void *test_realloc(void *ptr, size_t bytes)
{
	allocations++;
	if (bytes > largest_allocation)
		largest_allocation = bytes;
	if (fail_allocation)
		return NULL;
	return realloc(ptr, bytes);
}
#define TI_SNAPSHOT_REALLOC test_realloc
#include "tmux-ide-snapshot-buffer.h"

int main(void)
{
	struct ti_snapshot_buffer b = { .limit = 7 };
	assert(ti_snapshot_append(&b, "abc", 3) == 0);
	assert(ti_snapshot_append(&b, "defg", 4) == 0);
	assert(b.length == 7 && b.capacity == 8);
	assert(strcmp(b.data, "abcdefg") == 0);
	int before = allocations;
	assert(ti_snapshot_append(&b, "x", 1) == -1);
	assert(ti_snapshot_append(&b, "x", SIZE_MAX) == -1);
	assert(allocations == before && b.length == 7);
	assert(strcmp(b.data, "abcdefg") == 0);
	free(b.data);

	b = (struct ti_snapshot_buffer){ .limit = 0 };
	assert(ti_snapshot_append(&b, NULL, 0) == 0);
	assert(b.length == 0 && b.capacity == 1 && b.data[0] == 0);
	assert(ti_snapshot_append(&b, "x", 1) == -1);
	free(b.data);

	b = (struct ti_snapshot_buffer){ .limit = SIZE_MAX };
	before = allocations;
	assert(ti_snapshot_append(&b, NULL, 0) == -1);
	assert(allocations == before);
	b = (struct ti_snapshot_buffer){ .limit = 16000 };
	fail_allocation = 1;
	assert(ti_snapshot_append(&b, "x", 1) == -1);
	assert(b.data == NULL && b.capacity == 0 && b.length == 0);
	fail_allocation = 0;
	assert(ti_snapshot_append(&b, "x", 1) == 0);
	char *original = b.data;
	char block[4096];
	memset(block, 'q', sizeof block);
	fail_allocation = 1;
	assert(ti_snapshot_append(&b, block, sizeof block) == -1);
	assert(b.data == original && b.length == 1 && strcmp(b.data, "x") == 0);
	fail_allocation = 0;
	assert(ti_snapshot_append(&b, block, sizeof block) == 0);
	assert(b.length == 4097 && b.data[4097] == 0);
	assert(largest_allocation <= b.limit + 1);
	free(b.data);

	b = (struct ti_snapshot_buffer){ .limit = 16000 };
	allocations = 0;
	for (int i = 0; i < 16000; i++)
		assert(ti_snapshot_append(&b, "a", 1) == 0);
	assert(allocations <= 3 && b.capacity <= 16001);
	free(b.data);
	return 0;
}
